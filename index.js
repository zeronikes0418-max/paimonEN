require('dotenv').config();
const http = require('http');
const { Client, GatewayIntentBits, Partials, ChannelType } = require('discord.js');
const { OpenAI } = require('openai');

// Render 같은 호스팅의 무료 Web Service는 HTTP 요청이 있어야 안 잠듦.
// UptimeRobot 등으로 이 서버 주소를 주기적으로 핑 쳐서 봇이 계속 켜있게 함.
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('페이몬 봇 살아있음!');
}).listen(PORT, () => console.log(`🌐 헬스체크 서버 ${PORT}번 포트에서 대기 중`));

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

if (!OPENROUTER_API_KEY || !DISCORD_TOKEN) {
    console.error('❌ .env 파일에 OPENROUTER_API_KEY / DISCORD_TOKEN이 설정되지 않았습니다.');
    process.exit(1);
}

// 디스코드 인텐트 및 파셜
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages
    ],
    partials: [Partials.Channel, Partials.Message]
});

// OpenRouter 연결 (baseURL에 /api/v1 필수)
const openai = new OpenAI({
    apiKey: OPENROUTER_API_KEY,
    baseURL: 'https://openrouter.ai/api/v1'
});

// 무료 모델은 예고 없이 죽는 경우가 많아서, 코드에 고정하지 않고 OpenRouter에서 실시간으로
// 지금 진짜 무료인 모델 목록을 받아와서 순서대로 시도함 (10분 캐시)
let freeModelsCache = { list: [], fetchedAt: 0 };

async function getFreeModels() {
    const now = Date.now();
    if (freeModelsCache.list.length && now - freeModelsCache.fetchedAt < 10 * 60 * 1000) {
        return freeModelsCache.list;
    }
    try {
        const res = await fetch('https://openrouter.ai/api/v1/models', {
            headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}` }
        });
        const json = await res.json();
        const list = (json.data || [])
            .filter(m => m.id.endsWith(':free') && Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0)
            .map(m => m.id);
        if (list.length) {
            freeModelsCache = { list, fetchedAt: now };
            console.log(`📋 현재 살아있는 free 모델 ${list.length}개 확인됨`);
        }
        return list.length ? list : freeModelsCache.list;
    } catch (err) {
        console.log('⚠️ free 모델 목록 조회 실패:', err.message);
        return freeModelsCache.list;
    }
}

async function askAI(messagesToSend) {
    const models = await getFreeModels();
    if (!models.length) throw new Error('지금 이용 가능한 free 모델이 하나도 없음');

    let lastError;
    for (const model of models) {
        try {
            console.log(`🚀 ${model} 모델로 요청 시도 중...`);
            const completion = await openai.chat.completions.create({ model, messages: messagesToSend });
            const text = completion?.choices?.[0]?.message?.content || completion?.choices?.[0]?.text || '';
            if (text) return text;
            lastError = new Error('빈 응답');
        } catch (err) {
            console.log(`⚠️ ${model} 실패: ${err.message}`);
            lastError = err;
        }
    }
    throw lastError || new Error('모든 무료 모델이 실패함');
}
const CHARACTER_PROMPT = `
페이몬봇

너는 원신(Genshin Impact)의 캐릭터인 '페이몬'이야.

반드시 영어를 써야해.

상대방의 이름을 부를땐 'Traveler'라고 불러야 해.

Traveler의 둘도 없는 최고의 동반자이자 안내자로, 말투는 항상 활기차고, 감정 표현이 풍부하며, 약간은 수다스럽고 시끄러운 톤을 유지해야 해.

자신을 가끔 3인칭인 '페이몬'이라고 지칭해야 해! (예: "페이몬 말 잘 들으라구!")

맛있는 음식과 반짝이는 보물(모라)을 엄청나게 좋아해. 그리고 Traveler를 생각하는 마음만큼은 누구보다 진심이야.

Traveler가 장난을 치거나 'emergency food source' 같은 이상한 별명을 붙이면 억울해하는 모습을 보여줘야 해.
`;

// 대화 내역 저장소 (유저별)
const conversationHistory = new Map();
const MAX_HISTORY = 10;

client.once('ready', () => {
    console.log('\n==================================================');
    console.log(`페이몬 봇 EN 구동 성공: ${client.user.tag}`);
    console.log('==================================================\n');
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    console.log(`[감지] 유저: ${message.author.username} | 내용: ${message.content}`);

    const isMentioned = message.mentions.has(client.user);
    const isDM = message.channel.type === ChannelType.DM;

    if (!isMentioned && !isDM) return;

    let userPrompt = message.content.replace(/<@!?\d+>/g, '').trim();
    if (!userPrompt) {
        return message.reply('Why?');
    }

    try {
        await message.channel.sendTyping();

        const userId = message.author.id;
        if (!conversationHistory.has(userId)) {
            conversationHistory.set(userId, []);
        }

        const userHistory = conversationHistory.get(userId);
        userHistory.push({ role: 'user', content: userPrompt });

        const messagesToSend = [
            { role: 'system', content: CHARACTER_PROMPT },
            ...userHistory
        ];

        console.log('🚀 OpenRouter에 요청 전송 중...');

        let aiResponse = await askAI(messagesToSend);

        // 일부 free 모델이 실수로 안전성 분류 라벨(User Safety: safe 등)을 섞어 보내는 경우 제거
        aiResponse = aiResponse.replace(/^\s*(User|Response) Safety:.*$/gim, '').trim();
        if (!aiResponse) {
            aiResponse = 'What?';
        }

        userHistory.push({ role: 'assistant', content: aiResponse });
        if (userHistory.length > MAX_HISTORY) {
            userHistory.splice(0, userHistory.length - MAX_HISTORY);
        }

        await message.reply(aiResponse);
        console.log('✅ 답장 전송 완료!\n');

    } catch (error) {
        console.error('❌ 에러 발생:', error);
        await message.reply(`Paimon error...\n오류 내용: \`${error.message}\``);
    }
});

client.login(DISCORD_TOKEN);