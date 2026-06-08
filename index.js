// ── 1. 모듈 가져오기 ───────────────────────────────────────
const {
  Client,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags
} = require("discord.js");
const Groq  = require("groq-sdk");
const fetchModule = require("node-fetch");
const fetch = fetchModule.default || fetchModule;
require("dotenv").config();

// ── 2. 설정값 로드 ─────────────────────────────────────────
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GROQ_API_KEY  = process.env.GROQ_API_KEY;
const BOT_API_KEY   = process.env.BOT_API_KEY || "";
const SERVER_URL    = (process.env.SERVER_URL || "").replace(/\/$/, "");
const ADMIN_ID      = (process.env.ADMIN_ID || "").trim();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const ADMIN_AUTH_KEY = (process.env.ADMIN_AUTH_KEY || "").trim();
const ADMIN_DISCORD_IDS = new Set(
  (process.env.ADMIN_DISCORD_IDS || "")
    .split(",")
    .map(id => id.trim())
    .filter(Boolean)
);

// ── 3. 사용자 캐시 ────────────────────────────────────────
// discordId → { schoolCode, officeCode, schoolName, officeName, type, grade, classNo }
const userCache = new Map();
const loggedOutUsers = new Set();
const adminSessions = new Set();

async function getUser(discordId) {
  if (loggedOutUsers.has(discordId)) return null;
  if (userCache.has(discordId)) return userCache.get(discordId);

  try {
    const res = await fetch(`${SERVER_URL}/api/user/${encodeURIComponent(discordId)}`, { timeout: 5000 });
    if (!res.ok) return null;
    const data = await safeJson(res);
    if (!data?.schoolCode || !data?.officeCode) return null;
    userCache.set(discordId, data);
    return data;
  } catch {
    return null;
  }
}

// ── 4. Groq 클라이언트 ────────────────────────────────────
let groq;

const SYSTEM_PROMPT = `당신은 Discord 서버의 친절한 AI 어시스턴트입니다.
한국어와 영어 모두 유창하게 답변할 수 있습니다.
답변을 할 때 사용자가 질문한 것을 바로 답하시오. 예를 들어 "YOU : "등의 형식을 사용하지 마십시오.
사용자가 한국어로 말하면 반드시 자연스러운 한국어로 답변하세요.
한글이 깨진 문자(예: �, ì, ë, ê, í)가 섞이지 않도록 UTF-8 한글을 그대로 출력하세요.
답변은 간결하고 명확하게 해주세요. Discord 마크다운 형식을 활용해도 됩니다.`;

const KOREAN_RETRY_PROMPT = `${SYSTEM_PROMPT}

이전 응답이 한국어 품질 조건을 만족하지 못했습니다.
이번 응답은 한국어 문장으로만 다시 작성하세요.
영어 설명, 로마자 표기, 깨진 인코딩 문자를 사용하지 마세요.`;

const conversationHistory = new Map();
const MAX_HISTORY = 10;
const COMMAND_SYNC_DELAY_MS = 3000;
const EPHEMERAL_FLAGS = MessageFlags.Ephemeral;

// ── 5. KST 날짜 포맷 ──────────────────────────────────────
function kstTodayFormatted() {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const [y, m, day] = d.split("-");
  return `${y}년 ${m}월 ${day}일`;
}

// ── 6. Groq AI 호출 ───────────────────────────────────────
function hasHangul(text) {
  return /[가-힣]/.test(text);
}

function hasMojibake(text) {
  return /�|Ã|Â|ì|ë|ê|í|ð|ðŸ/.test(text);
}

function shouldRetryKoreanReply(userMessage, reply) {
  if (!hasHangul(userMessage)) return false;
  if (!reply || hasMojibake(reply)) return true;

  const letters = reply.match(/[A-Za-z가-힣]/g) || [];
  const hangul = reply.match(/[가-힣]/g) || [];
  if (letters.length < 10) return false;

  return hangul.length / letters.length < 0.25;
}

async function createGroqReply(systemPrompt, history) {
  const response = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    max_tokens: 1024,
    temperature: 0.4,
    messages: [{ role: "system", content: systemPrompt }, ...history]
  });

  return response.choices[0]?.message?.content?.trim() || "";
}

async function askGroq(channelId, userMessage) {
  if (!groq) return "❌ Groq API가 아직 초기화되지 않았습니다.";

  if (!conversationHistory.has(channelId)) {
    conversationHistory.set(channelId, []);
  }
  const history = conversationHistory.get(channelId);
  history.push({ role: "user", content: userMessage });

  try {
    let reply = await createGroqReply(SYSTEM_PROMPT, history);
    if (shouldRetryKoreanReply(userMessage, reply)) {
      const retryReply = await createGroqReply(KOREAN_RETRY_PROMPT, history);
      if (!shouldRetryKoreanReply(userMessage, retryReply)) {
        reply = retryReply;
      } else if (hasMojibake(reply) || !reply) {
        reply = "❌ 응답을 한국어로 정상 생성하지 못했습니다. 잠시 후 다시 시도해주세요.";
      }
    }

    history.push({ role: "assistant", content: reply });

    while (history.length > MAX_HISTORY * 2) history.splice(0, 2);
    return reply;
  } catch (e) {
    if (history.at(-1)?.role === "user") history.pop();
    return `❌ 오류: ${e.message}`;
  }
}

// ── 8. 급식 조회 ──────────────────────────────────────────
async function fetchMeal(schoolCode, officeCode) {
  try {
    const url = buildServerUrl("/api/dailyMeal", { schoolCode, officeCode });
    const res = await fetch(url, { timeout: 8000 });
    const data = await safeJson(res);
    if (!res.ok) return formatServerError(res, data);
    const menuRaw = data?.menu || "";
    if (!menuRaw) return "📭 오늘 급식 정보가 없습니다.";
    return menuRaw
      .replace(/<br\/>/g, "\n")
      .split("\n")
      .map(s => s.trim())
      .filter(Boolean)
      .map(s => `• ${s}`)
      .join("\n");
  } catch (e) { return `❌ 오류: ${e.message}`; }
}

// ── 9. 시간표 조회 ────────────────────────────────────────
async function fetchTimetable(schoolCode, officeCode, grade, classNo) {
  try {
    const url = buildServerUrl("/api/dailyTimetable", { schoolCode, officeCode, grade, classNo });
    const res = await fetch(url, { timeout: 8000 });
    const data = await safeJson(res);
    if (!res.ok) return formatServerError(res, data);
    if (!Array.isArray(data) || !data.length) return "📭 오늘 시간표 정보가 없습니다.";
    return data.map(item => `**${item.period}교시** ${item.subject}`).join("\n");
  } catch (e) { return `❌ 오류: ${e.message}`; }
}

async function searchSchools(name) {
  if (!SERVER_URL) throw new Error("SERVER_URL이 설정되지 않았습니다.");
  const url = buildServerUrl("/api/searchSchool", { name });
  let res;
  try {
    res = await fetch(url, { timeout: 8000 });
  } catch (e) {
    throw new Error(`서버 연결 실패: ${e.message || "네트워크 오류"}`);
  }

  const data = await safeJson(res);
  if (!res.ok) throw new Error(data?.message || data?.error || `서버 오류 (${res.status})`);
  if (!Array.isArray(data)) throw new Error("학교검색 API 응답 형식이 올바르지 않습니다.");

  return data
    .filter(school => school?.schoolCode && school?.officeCode)
    .slice(0, 10);
}

async function resolveSchoolOptions(interaction, { requireClass = false } = {}) {
  const user = await getUser(interaction.user.id);
  const school = {
    schoolCode: interaction.options.getString("학교코드")?.trim() || user?.schoolCode || "",
    officeCode: interaction.options.getString("교육청코드")?.trim() || user?.officeCode || "",
    schoolName: interaction.options.getString("학교명")?.trim() || user?.schoolName || "직접 입력한 학교",
    grade: interaction.options.getString("학년")?.trim() || user?.grade || "",
    classNo: interaction.options.getString("반")?.trim() || user?.classNo || ""
  };

  if (!school.schoolCode || !school.officeCode) {
    return {
      error:
        "⚠️ 학교코드와 교육청코드가 필요합니다.\n" +
        "`/학교검색 학교명:<학교이름>`으로 코드를 확인한 뒤 다시 입력하거나, `/회원가입`으로 기본 학교를 연동해주세요."
    };
  }

  if (requireClass && (!school.grade || !school.classNo)) {
    return {
      error:
        "⚠️ 시간표 조회에는 학년과 반이 필요합니다.\n" +
        "`/시간표 학교코드:<코드> 교육청코드:<코드> 학년:<학년> 반:<반>` 형식으로 입력하거나, `/회원가입`으로 기본 학급을 연동해주세요."
    };
  }

  return { school };
}

// ── 10. 긴 메시지 분할 전송 ───────────────────────────────
async function sendLong(interaction, content) {
  const chunks = content.match(/.{1,1990}/gs) || [];
  if (!chunks.length) return;

  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(chunks[0]);
    for (const chunk of chunks.slice(1)) await interaction.followUp(chunk);
    return;
  }

  await interaction.reply(chunks[0]);
  for (const chunk of chunks.slice(1)) await interaction.followUp(chunk);
}

async function safeJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function buildServerUrl(path, params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    query.set(key, String(value || ""));
  }
  const queryText = query.toString();
  return `${SERVER_URL}${path}${queryText ? `?${queryText}` : ""}`;
}

function formatServerError(res, data) {
  const message = data?.message || data?.error || "알 수 없는 오류";
  return `❌ 서버 오류 (${res.status}): ${message}`;
}

function botApiHeaders(extraHeaders = {}) {
  return {
    ...extraHeaders,
    ...(BOT_API_KEY ? { "x-bot-key": BOT_API_KEY } : {})
  };
}

function adminApiHeaders() {
  return {
    "x-admin-id": ADMIN_ID,
    "x-admin-password": ADMIN_PASSWORD,
    ...(ADMIN_AUTH_KEY ? { "x-admin-key": ADMIN_AUTH_KEY } : {})
  };
}

function isAdminDiscordUser(discordId) {
  return ADMIN_DISCORD_IDS.has(discordId);
}

async function fetchAdminMonitor() {
  if (!ADMIN_ID || !ADMIN_PASSWORD || !ADMIN_DISCORD_IDS.size) {
    throw new Error("관리자 봇 설정이 완료되지 않았습니다.");
  }

  const res = await fetch(`${SERVER_URL}/admin/monitor`, {
    headers: adminApiHeaders(),
    timeout: 8000
  });
  const data = await safeJson(res);
  if (!res.ok) throw new Error(data?.message || data?.error || `관리자 인증 실패 (${res.status})`);
  return data;
}

function formatDateTime(value) {
  if (!value) return "서버에서 제공되지 않음";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "서버에서 제공되지 않음";
  return date.toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
}

async function checkServerConnection() {
  const res = await fetch(`${SERVER_URL}/health`, { timeout: 5000 });
  const data = await safeJson(res);

  if (!res.ok) {
    throw new Error(`서버 상태 확인 실패 (${res.status})`);
  }
  if (data?.db === false) {
    throw new Error("MongoDB가 아직 연결되지 않았습니다.");
  }
}

// ── 11. 클라이언트 생성 ───────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// ── 12. 슬래시 커맨드 정의 ────────────────────────────────
const commandHelpItems = [
  ["회원가입", "회원가입 웹페이지 링크와 Discord 연동 방법을 안내합니다."],
  ["로그인", "회원가입 후 발급된 6자리 토큰으로 계정을 연동합니다."],
  ["로그아웃", "현재 봇 세션에서 학교 연동 정보를 로그아웃합니다."],
  ["내정보", "Discord 프로필과 봇 서비스 연동 정보를 확인합니다."],
  ["학교검색", "학교 이름으로 학교 정보를 검색합니다."],
  ["급식", "오늘 급식 메뉴를 조회합니다. 학교코드/교육청코드를 입력하면 로그인 없이도 사용할 수 있습니다."],
  ["시간표", "오늘 시간표를 조회합니다. 학교코드/교육청코드/학년/반을 입력하면 로그인 없이도 사용할 수 있습니다."],
  ["관리자로그인", "허용된 관리자의 서버 인증을 확인합니다."],
  ["관리자상태", "로그인한 관리자에게 서버 상태를 보여줍니다."],
  ["관리자로그아웃", "관리자 세션을 종료합니다."],
  ["ping", "봇 응답 속도를 확인합니다."],
  ["chat", "Groq AI와 대화합니다."],
  ["clear", "현재 채널의 AI 대화 기록을 초기화합니다."],
  ["status", "현재 채널의 AI 대화 기록 수를 확인합니다."],
  ["도움말", "사용 가능한 봇 커맨드 설명을 보여줍니다."]
];

const commands = [
  new SlashCommandBuilder()
    .setName("회원가입")
    .setDescription("회원가입 웹페이지 링크와 Discord 연동 방법을 안내합니다"),
  new SlashCommandBuilder()
    .setName("로그인")
    .setDescription("회원가입 후 발급된 6자리 토큰으로 Discord 계정을 연동합니다")
    .addStringOption(o =>
      o.setName("토큰").setDescription("회원가입 페이지에서 발급된 6자리 토큰").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("로그아웃")
    .setDescription("현재 봇 세션에서 학교 연동 정보를 로그아웃합니다"),
  new SlashCommandBuilder()
    .setName("내정보")
    .setDescription("Discord 프로필과 봇 서비스 연동 정보를 확인합니다"),
  new SlashCommandBuilder()
    .setName("학교검색")
    .setDescription("학교 이름으로 학교 정보를 검색합니다")
    .addStringOption(o =>
      o.setName("학교명").setDescription("검색할 학교 이름").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("급식")
    .setDescription("오늘 급식 메뉴를 보여줍니다")
    .addStringOption(o =>
      o.setName("학교코드").setDescription("/학교검색으로 확인한 학교코드").setRequired(false)
    )
    .addStringOption(o =>
      o.setName("교육청코드").setDescription("/학교검색으로 확인한 교육청코드").setRequired(false)
    )
    .addStringOption(o =>
      o.setName("학교명").setDescription("응답에 표시할 학교명").setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName("시간표")
    .setDescription("오늘 시간표를 보여줍니다")
    .addStringOption(o =>
      o.setName("학교코드").setDescription("/학교검색으로 확인한 학교코드").setRequired(false)
    )
    .addStringOption(o =>
      o.setName("교육청코드").setDescription("/학교검색으로 확인한 교육청코드").setRequired(false)
    )
    .addStringOption(o =>
      o.setName("학년").setDescription("조회할 학년").setRequired(false)
    )
    .addStringOption(o =>
      o.setName("반").setDescription("조회할 반").setRequired(false)
    )
    .addStringOption(o =>
      o.setName("학교명").setDescription("응답에 표시할 학교명").setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName("관리자로그인")
    .setDescription("허용된 관리자의 서버 인증을 확인합니다"),
  new SlashCommandBuilder()
    .setName("관리자상태")
    .setDescription("로그인한 관리자에게 서버 상태를 보여줍니다"),
  new SlashCommandBuilder()
    .setName("관리자로그아웃")
    .setDescription("관리자 세션을 종료합니다"),
  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("봇 응답 속도를 확인합니다"),
  new SlashCommandBuilder()
    .setName("chat")
    .setDescription("Groq AI와 대화합니다")
    .addStringOption(o =>
      o.setName("message").setDescription("AI에게 보낼 메시지").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("clear")
    .setDescription("대화 기록을 초기화합니다"),
  new SlashCommandBuilder()
    .setName("status")
    .setDescription("현재 채널의 AI 대화 기록 수를 확인합니다"),
  new SlashCommandBuilder()
    .setName("도움말")
    .setDescription("사용 가능한 봇 커맨드 설명을 보여줍니다")
].map(c => c.toJSON());

const commandHelpText =
  `**사용 가능한 커맨드**\n\n` +
  commandHelpItems
    .map(([name, description]) => `\`/${name}\` - ${description}`)
    .join("\n");

const managedCommandNames = new Set(commands.map(command => command.name));
let slashCommandsReady = false;

async function syncSlashCommands(applicationId) {
  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  try {
    slashCommandsReady = false;

    const existingCommands = await rest.get(Routes.applicationCommands(applicationId));
    const existingChatCommands = new Map(
      existingCommands
        .filter(command => command.type === 1)
        .map(command => [command.name, command])
    );

    for (const command of commands) {
      const existing = existingChatCommands.get(command.name);
      if (existing) {
        await rest.patch(Routes.applicationCommand(applicationId, existing.id), { body: command });
      } else {
        await rest.post(Routes.applicationCommands(applicationId), { body: command });
      }
    }

    const syncedCommands = await rest.get(Routes.applicationCommands(applicationId));
    const syncedChatCommandNames = new Set(
      syncedCommands
        .filter(command => command.type === 1)
        .map(command => command.name)
    );
    const missingCommands = commands
      .map(command => command.name)
      .filter(name => !syncedChatCommandNames.has(name));

    if (missingCommands.length) {
      throw new Error(`동기화 누락: ${missingCommands.join(", ")}`);
    }

    slashCommandsReady = true;
    console.log(`📡 슬래시 커맨드 ${commands.length}개 동기화 완료 및 활성화`);
  } catch (e) {
    slashCommandsReady = false;
    console.error("⚠️ 슬래시 커맨드 등록 실패:", e.message);
  }
}

// ── 13. 봇 준비 완료 ──────────────────────────────────────
client.once(Events.ClientReady, (readyClient) => {
  console.log(`✅ Ready! Logged in as ${readyClient.user.tag}`);
  console.log("⏳ 슬래시 커맨드 동기화는 후순위로 진행합니다.");

  setTimeout(() => {
    syncSlashCommands(readyClient.user.id);
  }, COMMAND_SYNC_DELAY_MS);
});

// ── 14. 메시지 응답 (멘션 + ping/pong) ───────────────────
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  if (message.content.includes("ping")) {
    const sent = await message.reply("pong");
    const elapsed = sent.createdTimestamp - message.createdTimestamp;
    await sent.edit(`pong (${elapsed}ms)`);
    return;
  }

  if (client.user && message.mentions.has(client.user)) {
    const content = message.content.replace(`<@${client.user.id}>`, "").trim();
    if (!content) {
      await message.reply("안녕하세요! 무엇을 도와드릴까요? 😊");
      return;
    }
    const reply = await askGroq(message.channelId, content);
    if (reply.length > 2000) {
      const chunks = reply.match(/.{1,1990}/gs) || [];
      for (let i = 0; i < chunks.length; i++) {
        i === 0 ? await message.reply(chunks[i]) : await message.channel.send(chunks[i]);
      }
    } else {
      await message.reply(reply);
    }
  }
});

// ── 15. 인터랙션 처리 ─────────────────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {

  if (interaction.isChatInputCommand()) {
    const { commandName } = interaction;

    if (managedCommandNames.has(commandName) && !slashCommandsReady) {
      await interaction.reply({
        content: "⏳ 봇 커맨드를 동기화하는 중입니다. 잠시 후 다시 시도해주세요.",
        flags: EPHEMERAL_FLAGS
      });
      return;
    }

    // /회원가입
    if (commandName === "회원가입") {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel("회원가입 페이지 열기")
          .setStyle(ButtonStyle.Link)
          .setURL(`${SERVER_URL}/register`)
      );

      await interaction.reply({
        content:
          `📝 **회원가입 안내**\n\n` +
          `아래 링크에서 학교 정보를 입력하고 가입하세요.\n` +
          `가입 완료 후 발급된 **6자리 토큰**을 \`/로그인 [토큰]\` 으로 입력하면 연동됩니다.\n\n` +
          `🔗 ${SERVER_URL}/register\n\n` +
          `⏱ 토큰은 발급 후 **5분** 이내에 입력해야 합니다.`,
        components: [row],
        flags: EPHEMERAL_FLAGS
      });
    }

    // /로그인
    else if (commandName === "로그인") {
      await interaction.deferReply({ flags: EPHEMERAL_FLAGS });
      const token = interaction.options.getString("토큰").trim();

      try {
        const res = await fetch(`${SERVER_URL}/api/verify`, {
          method: "POST",
          headers: botApiHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({
            token,
            discordId: interaction.user.id,
            guildId:   interaction.guildId
          })
        });

        if (res.status === 404) {
          await interaction.editReply("❌ 토큰이 존재하지 않습니다. 회원가입 페이지에서 다시 발급받으세요.");
          return;
        }
        if (res.status === 410) {
          await interaction.editReply("⏱ 토큰이 만료되었습니다. `/회원가입` 으로 다시 시도해주세요.");
          return;
        }

        const data = await safeJson(res);

        if (!res.ok) {
          await interaction.editReply(`❌ 오류: ${data?.message || data?.error || "알 수 없는 오류"}`);
          return;
        }
        if (!data?.user) {
          await interaction.editReply("❌ 서버 응답에 사용자 정보가 없습니다.");
          return;
        }

        // 캐시 업데이트
        loggedOutUsers.delete(interaction.user.id);
        userCache.set(interaction.user.id, data.user);

        await interaction.editReply(
          `✅ **로그인 완료!**\n\n` +
          `🏫 **${data.user.schoolName}** ${data.user.grade}학년 ${data.user.classNo}반\n` +
          `이제 \`/급식\`, \`/시간표\` 커맨드를 사용할 수 있습니다!`
        );
      } catch (e) {
        await interaction.editReply("❌ 서버 연결에 실패했습니다. 잠시 후 다시 시도해주세요.");
      }
    }

    // /로그아웃
    else if (commandName === "로그아웃") {
      let serverUnlinked = false;
      try {
        const res = await fetch(`${SERVER_URL}/api/discord/unlink`, {
          method: "POST",
          headers: botApiHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({ discordId: interaction.user.id }),
          timeout: 5000
        });
        serverUnlinked = res.ok;
      } catch {
        serverUnlinked = false;
      }

      loggedOutUsers.add(interaction.user.id);
      userCache.delete(interaction.user.id);

      await interaction.reply({
        content:
          "✅ **로그아웃 완료!**\n\n" +
          (serverUnlinked
            ? "서버의 Discord 연동 정보를 해제했습니다.\n"
            : "현재 봇 세션에서 학교 연동 정보를 사용하지 않도록 처리했습니다.\n") +
          "다시 사용하려면 `/로그인`으로 6자리 토큰을 입력해주세요.",
        flags: EPHEMERAL_FLAGS
      });
    }

    // /내정보
    else if (commandName === "내정보") {
      await interaction.deferReply({ flags: EPHEMERAL_FLAGS });
      const user = await getUser(interaction.user.id);
      const accountUrl = `${SERVER_URL}/account`;
      const serviceJoinedAt = user?.serviceJoinedAt || user?.createdAt || user?.agreedAt || user?.linkedAt || user?.updatedAt;
      const schoolText = user
        ? `${user.schoolName || "알 수 없음"} ${user.grade || "?"}학년 ${user.classNo || "?"}반`
        : "연동된 정보가 없습니다.";
      const avatarUrl = interaction.user.displayAvatarURL({ size: 256 });
      const profileEmbed = new EmbedBuilder()
        .setTitle("내 정보")
        .setThumbnail(avatarUrl)
        .setColor(user ? 0x2ecc71 : 0xf1c40f)
        .addFields(
          { name: "이름", value: interaction.user.tag || interaction.user.username, inline: true },
          { name: "Discord ID", value: interaction.user.id, inline: true },
          { name: "Discord 가입일", value: formatDateTime(interaction.user.createdAt), inline: false },
          { name: "봇 서비스 가입일", value: user ? formatDateTime(serviceJoinedAt) : "연동된 정보가 없습니다.", inline: false },
          { name: "학교 정보", value: schoolText, inline: false }
        );
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel("웹페이지 바로가기")
          .setStyle(ButtonStyle.Link)
          .setURL(accountUrl)
      );

      await interaction.editReply({ embeds: [profileEmbed], components: [row] });
    }

    // /학교검색
    else if (commandName === "학교검색") {
      await interaction.deferReply({ flags: EPHEMERAL_FLAGS });
      const schoolName = interaction.options.getString("학교명").trim();

      try {
        const schools = await searchSchools(schoolName);
        if (!schools.length) {
          await interaction.editReply(`🔍 **${schoolName}** 검색 결과가 없습니다.`);
          return;
        }

        const searchEmbed = new EmbedBuilder()
          .setTitle(`학교 검색 결과: ${schoolName}`)
          .setColor(0x3498db)
          .setDescription(
            schools.map((school, index) => {
              const office = school.officeName || "교육청 정보 없음";
              const type = school.type || "학교";
              return (
                `**${index + 1}. ${school.name || "이름 없음"}**\n` +
                `${type} | ${office}\n` +
                `학교코드: \`${school.schoolCode}\`\n` +
                `교육청코드: \`${school.officeCode}\``
              );
            }).join("\n\n")
          )
          .setFooter({ text: `${schools.length}개 표시 (최대 10개)` });

        await interaction.editReply({ embeds: [searchEmbed] });
      } catch (e) {
        await interaction.editReply(`❌ 학교 검색 실패: ${e.message}`);
      }
    }

    // /급식
    else if (commandName === "급식") {
      await interaction.deferReply({ flags: EPHEMERAL_FLAGS });
      const { school, error } = await resolveSchoolOptions(interaction);
      if (error) {
        await interaction.editReply(error);
        return;
      }
      const menu = await fetchMeal(school.schoolCode, school.officeCode);
      await interaction.editReply(`🍱 **${kstTodayFormatted()} 급식** (${school.schoolName})\n\n${menu}`);
    }

    // /시간표
    else if (commandName === "시간표") {
      await interaction.deferReply({ flags: EPHEMERAL_FLAGS });
      const { school, error } = await resolveSchoolOptions(interaction, { requireClass: true });
      if (error) {
        await interaction.editReply(error);
        return;
      }
      const table = await fetchTimetable(school.schoolCode, school.officeCode, school.grade, school.classNo);
      await interaction.editReply(
        `📚 **${kstTodayFormatted()} 시간표** (${school.schoolName} ${school.grade}학년 ${school.classNo}반)\n\n${table}`
      );
    }

    // /관리자로그인
    else if (commandName === "관리자로그인") {
      await interaction.deferReply({ flags: EPHEMERAL_FLAGS });
      if (!isAdminDiscordUser(interaction.user.id)) {
        await interaction.editReply("❌ 관리자 권한이 없습니다.");
        return;
      }

      try {
        await fetchAdminMonitor();
        adminSessions.add(interaction.user.id);
        await interaction.editReply("✅ 관리자 인증이 완료되었습니다. `/관리자상태`를 사용할 수 있습니다.");
      } catch (e) {
        await interaction.editReply(`❌ 관리자 로그인 실패: ${e.message}`);
      }
    }

    // /관리자상태
    else if (commandName === "관리자상태") {
      await interaction.deferReply({ flags: EPHEMERAL_FLAGS });
      if (!isAdminDiscordUser(interaction.user.id) || !adminSessions.has(interaction.user.id)) {
        await interaction.editReply("❌ 먼저 `/관리자로그인`을 실행해주세요.");
        return;
      }

      try {
        const monitor = await fetchAdminMonitor();
        const statusEmbed = new EmbedBuilder()
          .setTitle("관리자 서버 상태")
          .setColor(0x2ecc71)
          .addFields(
            { name: "전체 요청", value: String(monitor?.traffic?.total ?? "-"), inline: true },
            { name: "오늘 요청", value: String(monitor?.traffic?.today ?? "-"), inline: true },
            { name: "메모리 (MB)", value: String(monitor?.system?.memoryMb ?? "-"), inline: true },
            { name: "가동 시간 (초)", value: String(monitor?.system?.uptimeSec ?? "-"), inline: true },
            { name: "의심 IP", value: String(monitor?.security?.suspiciousCount ?? "-"), inline: true },
            { name: "공지 수", value: String(monitor?.notices?.total ?? "-"), inline: true }
          )
          .setTimestamp();

        await interaction.editReply({ embeds: [statusEmbed] });
      } catch (e) {
        adminSessions.delete(interaction.user.id);
        await interaction.editReply(`❌ 관리자 상태 조회 실패: ${e.message}`);
      }
    }

    // /관리자로그아웃
    else if (commandName === "관리자로그아웃") {
      adminSessions.delete(interaction.user.id);
      await interaction.reply({
        content: "✅ 관리자 세션을 종료했습니다.",
        flags: EPHEMERAL_FLAGS
      });
    }

    // /ping
    else if (commandName === "ping") {
      const elapsed = Date.now() - interaction.createdTimestamp;
      await interaction.reply(`pong (${elapsed}ms)`);
    }

    // /chat
    else if (commandName === "chat") {
      await interaction.deferReply();
      const msg = interaction.options.getString("message");
      const reply = await askGroq(interaction.channelId, msg);
      await sendLong(interaction, `**You:** ${msg}\n\n${reply}`);
    }

    // /clear
    else if (commandName === "clear") {
      conversationHistory.delete(interaction.channelId);
      await interaction.reply({ content: "🗑️ 대화 기록이 초기화되었습니다!", flags: EPHEMERAL_FLAGS });
    }

    // /status
    else if (commandName === "status") {
      const count = Math.floor((conversationHistory.get(interaction.channelId)?.length || 0) / 2);
      await interaction.reply({
        content: `💬 현재 채널 대화 기록: **${count}턴** (최대 ${MAX_HISTORY}턴)`,
        flags: EPHEMERAL_FLAGS
      });
    }

    // /도움말
    else if (commandName === "도움말") {
      await interaction.reply({
        content: commandHelpText,
        flags: EPHEMERAL_FLAGS
      });
    }
  }
});

// ── 16. 실행 ──────────────────────────────────────────────
async function startBot() {
  if (!DISCORD_TOKEN) {
    throw new Error("DISCORD_TOKEN이 설정되지 않았습니다!");
  }
  if (!GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY가 설정되지 않았습니다!");
  }

  console.log(`🔎 서버/DB 연결 확인 중: ${SERVER_URL}`);
  await checkServerConnection();
  console.log("✅ 서버/DB 연결 확인 완료");

  groq = new Groq({ apiKey: GROQ_API_KEY });
  console.log("✅ Groq API 초기화 완료");

  await client.login(DISCORD_TOKEN);
}

startBot().catch((e) => {
  console.error(`❌ 시작 실패: ${e.message}`);
  process.exit(1);
});
