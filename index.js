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
  ButtonStyle
} = require("discord.js");
const Groq  = require("groq-sdk");
const fetchModule = require("node-fetch");
const fetch = fetchModule.default || fetchModule;
require("dotenv").config();

// ── 2. 설정값 로드 ─────────────────────────────────────────
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GROQ_API_KEY  = process.env.GROQ_API_KEY;
const SERVER_URL    = (process.env.SERVER_URL || "http://localhost:8000").replace(/\/$/, "");

// ── 3. 사용자 캐시 ────────────────────────────────────────
// discordId → { schoolCode, officeCode, schoolName, officeName, type, grade, classNo }
const userCache = new Map();

async function getUser(discordId) {
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

async function checkServerConnection() {
  const res = await fetch(`${SERVER_URL}/health`, { timeout: 5000 });
  const data = await safeJson(res);

  if (!res.ok) {
    throw new Error(`서버 상태 확인 실패 (${res.status})`);
  }
  if (data?.db !== true) {
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
  ["내정보", "현재 연동된 학교, 학년, 반 정보를 확인합니다."],
  ["급식", "오늘 급식 메뉴를 조회합니다."],
  ["시간표", "오늘 시간표를 조회합니다."],
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
    .setName("내정보")
    .setDescription("현재 연동된 내 학교 정보를 확인합니다"),
  new SlashCommandBuilder()
    .setName("급식")
    .setDescription("오늘 급식 메뉴를 보여줍니다"),
  new SlashCommandBuilder()
    .setName("시간표")
    .setDescription("오늘 시간표를 보여줍니다"),
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
        await rest.put(Routes.applicationCommand(applicationId, existing.id), { body: command });
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
        ephemeral: true
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
        ephemeral: true
      });
    }

    // /로그인
    else if (commandName === "로그인") {
      await interaction.deferReply({ ephemeral: true });
      const token = interaction.options.getString("토큰").trim();

      try {
        const res = await fetch(`${SERVER_URL}/api/verify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
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

    // /내정보
    else if (commandName === "내정보") {
      await interaction.deferReply({ ephemeral: true });
      const user = await getUser(interaction.user.id);
      if (!user) {
        await interaction.editReply("⚠️ 연동된 정보가 없습니다. `/회원가입` 으로 먼저 가입해주세요.");
        return;
      }

      const officeText = user.officeName ? `, ${user.officeName}` : "";
      const typeText   = user.type || "학교";

      await interaction.editReply(
          `👤 **내 학교 정보**\n\n` +
          `📌 학교명: **${user.schoolName} (${typeText}${officeText})**\n` +
          `📍 지역: ${user.officeName || "알 수 없음"}\n` +
          `👤 학년/반: **${user.grade}학년 ${user.classNo}반**`
      );
    }

    // /급식
    else if (commandName === "급식") {
      await interaction.deferReply();
      const user = await getUser(interaction.user.id);
      if (!user) {
        await interaction.editReply("⚠️ `/회원가입` 으로 먼저 학교를 등록해주세요.");
        return;
      }
      const menu = await fetchMeal(user.schoolCode, user.officeCode);
      await interaction.editReply(`🍱 **${kstTodayFormatted()} 급식** (${user.schoolName})\n\n${menu}`);
    }

    // /시간표
    else if (commandName === "시간표") {
      await interaction.deferReply();
      const user = await getUser(interaction.user.id);
      if (!user) {
        await interaction.editReply("⚠️ `/회원가입` 으로 먼저 학교를 등록해주세요.");
        return;
      }
      const table = await fetchTimetable(user.schoolCode, user.officeCode, user.grade, user.classNo);
      await interaction.editReply(
        `📚 **${kstTodayFormatted()} 시간표** (${user.schoolName} ${user.grade}학년 ${user.classNo}반)\n\n${table}`
      );
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
      await interaction.reply({ content: "🗑️ 대화 기록이 초기화되었습니다!", ephemeral: true });
    }

    // /status
    else if (commandName === "status") {
      const count = Math.floor((conversationHistory.get(interaction.channelId)?.length || 0) / 2);
      await interaction.reply({
        content: `💬 현재 채널 대화 기록: **${count}턴** (최대 ${MAX_HISTORY}턴)`,
        ephemeral: true
      });
    }

    // /도움말
    else if (commandName === "도움말") {
      await interaction.reply({
        content: commandHelpText,
        ephemeral: true
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
