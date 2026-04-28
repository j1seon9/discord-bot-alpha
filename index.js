// ── 1. 모듈 가져오기 ───────────────────────────────────────
const {
  Client,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  InteractionType
} = require("discord.js");
const Groq  = require("groq-sdk");
const fetch = require("node-fetch");
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
    const res = await fetch(`${SERVER_URL}/api/user/${encodeURIComponent(discordId)}`);
    if (!res.ok) return null;
    const data = await res.json();
    userCache.set(discordId, data);
    return data;
  } catch {
    return null;
  }
}

// ── 4. Groq 클라이언트 ────────────────────────────────────
const groq = new Groq({ apiKey: GROQ_API_KEY });

const SYSTEM_PROMPT = `당신은 Discord 서버의 친절한 AI 어시스턴트입니다.
한국어와 영어 모두 유창하게 답변할 수 있습니다.
답변은 간결하고 명확하게 해주세요. Discord 마크다운 형식을 활용해도 됩니다.`;

const conversationHistory = new Map();
const MAX_HISTORY = 10;

// ── 5. KST 날짜 포맷 ──────────────────────────────────────
function kstTodayFormatted() {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const [y, m, day] = d.split("-");
  return `${y}년 ${m}월 ${day}일`;
}

// ── 6. Groq AI 호출 ───────────────────────────────────────
async function askGroq(channelId, userMessage) {
  if (!conversationHistory.has(channelId)) {
    conversationHistory.set(channelId, []);
  }
  const history = conversationHistory.get(channelId);
  history.push({ role: "user", content: userMessage });

  try {
    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      max_tokens: 1024,
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...history]
    });

    const reply = response.choices[0].message.content;
    history.push({ role: "assistant", content: reply });

    while (history.length > MAX_HISTORY * 2) history.splice(0, 2);
    return reply;
  } catch (e) {
    if (history.at(-1)?.role === "user") history.pop();
    return `❌ 오류: ${e.message}`;
  }
}

// ── 7. 학교 검색 ──────────────────────────────────────────
async function searchSchool(name) {
  try {
    const res = await fetch(`${SERVER_URL}/api/searchSchool?name=${encodeURIComponent(name)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return Array.isArray(data)
      ? data.map(r => ({
          name:       String(r.name       || "").trim(),
          schoolCode: String(r.schoolCode || "").trim(),
          officeCode: String(r.officeCode || "").trim(),
          officeName: String(r.officeName || "").trim(),
          type:       String(r.type       || "학교").trim()
        })).filter(r => r.schoolCode && r.officeCode)
      : [];
  } catch { return []; }
}

// ── 8. 급식 조회 ──────────────────────────────────────────
async function fetchMeal(schoolCode, officeCode) {
  try {
    const res = await fetch(`${SERVER_URL}/api/dailyMeal?schoolCode=${schoolCode}&officeCode=${officeCode}`);
    if (!res.ok) return `❌ 서버 오류 (${res.status})`;
    const data = await res.json();
    const menuRaw = data.menu || "";
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
    const res = await fetch(
      `${SERVER_URL}/api/dailyTimetable?schoolCode=${schoolCode}&officeCode=${officeCode}&grade=${grade}&classNo=${classNo}`
    );
    if (!res.ok) return `❌ 서버 오류 (${res.status})`;
    const data = await res.json();
    if (!data.length) return "📭 오늘 시간표 정보가 없습니다.";
    return data.map(item => `**${item.period}교시** ${item.subject}`).join("\n");
  } catch (e) { return `❌ 오류: ${e.message}`; }
}

// ── 10. 긴 메시지 분할 전송 ───────────────────────────────
async function sendLong(interaction, content) {
  const chunks = content.match(/.{1,1990}/gs) || [];
  for (const chunk of chunks) await interaction.followUp(chunk);
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
const commands = [
  new SlashCommandBuilder()
    .setName("회원가입")
    .setDescription("웹 페이지에서 학교 정보를 등록합니다"),
  new SlashCommandBuilder()
    .setName("로그인")
    .setDescription("회원가입 후 발급된 토큰으로 봇과 연동합니다")
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
    .setName("chat")
    .setDescription("AI와 대화합니다")
    .addStringOption(o =>
      o.setName("message").setDescription("AI에게 보낼 메시지").setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("clear")
    .setDescription("대화 기록을 초기화합니다"),
  new SlashCommandBuilder()
    .setName("status")
    .setDescription("현재 대화 기록 수를 확인합니다")
].map(c => c.toJSON());

// ── 13. 봇 준비 완료 ──────────────────────────────────────
client.once(Events.ClientReady, async (readyClient) => {
  console.log(`✅ Ready! Logged in as ${readyClient.user.tag}`);

  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(readyClient.user.id), { body: commands });
    console.log(`📡 슬래시 커맨드 ${commands.length}개 등록 완료`);
  } catch (e) {
    console.error("⚠️ 슬래시 커맨드 등록 실패:", e.message);
  }
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

    // /회원가입
    if (commandName === "회원가입") {
      await interaction.reply({
        content:
          `📝 **회원가입 안내**\n\n` +
          `아래 링크에서 학교 정보를 입력하고 가입하세요.\n` +
          `가입 완료 후 발급된 **6자리 토큰**을 \`/로그인 [토큰]\` 으로 입력하면 연동됩니다.\n\n` +
          `🔗 ${SERVER_URL}/register\n\n` +
          `⏱ 토큰은 발급 후 **5분** 이내에 입력해야 합니다.`,
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

        const data = await res.json();

        if (res.status === 404) {
          await interaction.editReply("❌ 토큰이 존재하지 않습니다. 회원가입 페이지에서 다시 발급받으세요.");
          return;
        }
        if (res.status === 410) {
          await interaction.editReply("⏱ 토큰이 만료되었습니다. `/회원가입` 으로 다시 시도해주세요.");
          return;
        }
        if (!res.ok) {
          await interaction.editReply(`❌ 오류: ${data.error || "알 수 없는 오류"}`);
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
      const user = await getUser(interaction.user.id);
      if (!user) {
        await interaction.reply({
          content: "⚠️ 연동된 정보가 없습니다. `/회원가입` 으로 먼저 가입해주세요.",
          ephemeral: true
        });
        return;
      }

      const officeText = user.officeName ? `, ${user.officeName}` : "";
      const typeText   = user.type || "학교";

      await interaction.reply({
        content:
          `👤 **내 학교 정보**\n\n` +
          `📌 학교명: **${user.schoolName} (${typeText}${officeText})**\n` +
          `📍 지역: ${user.officeName || "알 수 없음"}\n` +
          `👤 학년/반: **${user.grade}학년 ${user.classNo}반**`,
        ephemeral: true
      });
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
  }
});

// ── 16. 실행 ──────────────────────────────────────────────
if (!DISCORD_TOKEN) {
  console.error("❌ DISCORD_TOKEN이 설정되지 않았습니다!");
  process.exit(1);
} else if (!GROQ_API_KEY) {
  console.error("❌ GROQ_API_KEY가 설정되지 않았습니다!");
  process.exit(1);
} else {
  client.login(DISCORD_TOKEN);
}