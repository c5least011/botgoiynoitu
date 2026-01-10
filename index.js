require('dotenv').config();
const { 
    Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, 
    ActionRowBuilder, ButtonBuilder, ButtonStyle 
} = require('discord.js');
const axios = require('axios');
const mongoose = require('mongoose');

// --- CẤU HÌNH DB ---
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ Đã thông nòng MongoDB'))
    .catch(err => console.error('❌ Lỗi DB:', err));

const WordSchema = new mongoose.Schema({ text: { type: String, unique: true } });
const WordModel = mongoose.model('Word', WordSchema);

// --- CẤU HÌNH BOT ---
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
let allWords = new Set(); 
let priorityWords = new Set(); // Ưu tiên số 1
let mongoWords = new Set(); // Bình đẳng, dùng để hiện ⭐
const suggestionHistory = new Map();

const PRIORITY_SOURCE = 'https://raw.githubusercontent.com/c5least011/botgoiynoitu/refs/heads/main/data.json';
const jsonSources = [
    'https://raw.githubusercontent.com/undertheseanlp/dictionary/refs/heads/wiktionary/dictionary/words.txt',
    'https://raw.githubusercontent.com/undertheseanlp/dictionary/refs/heads/tudientv/dictionary/words.txt',
    'https://raw.githubusercontent.com/undertheseanlp/dictionary/refs/heads/hongocduc/dictionary/words.txt'
];
const plainTextSource = 'https://raw.githubusercontent.com/lvdat/phobo-contribute-words/refs/heads/main/accepted-words.txt';

function isValid(w) {
    if (!w || w.includes(':') || w.includes('*') || w.includes('-')) return false;
    return w.split(/\s+/).length === 2;
}

async function loadDict() {
    console.log('--- Đang quét kho vũ khí ---');
    
    // 1. Load hàng ƯU TIÊN SỐ 1 (Link JSON m vừa đưa)
    try {
        const res = await axios.get(PRIORITY_SOURCE);
        // Fix lỗi dấu ngoặc kép thông minh trong JSON
        let rawData = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
        let data = JSON.parse(rawData.replace(/“|”/g, '"'));
        
        if (Array.isArray(data)) {
            data.forEach(w => {
                let clean = w.trim().toLowerCase();
                if (isValid(clean)) {
                    priorityWords.add(clean);
                    allWords.add(clean);
                }
            });
            console.log(`✅ Đã nạp ${priorityWords.size} từ ƯU TIÊN.`);
        }
    } catch (err) { console.log('❌ Lỗi nạp source cá nhân:', err.message); }

    // 2. Load MongoDB (Bình đẳng)
    try {
        const dbWords = await WordModel.find();
        dbWords.forEach(w => {
            let clean = w.text.trim().toLowerCase();
            allWords.add(clean);
            mongoWords.add(clean);
        });
        console.log(`✅ Đã nạp ${dbWords.length} từ từ MongoDB.`);
    } catch (err) { console.log('❌ Lỗi nạp Mongo'); }

    // 3. Load GitHub Sources công cộng (Bình đẳng)
    for (const url of jsonSources) {
        try {
            const res = await axios.get(url, { responseType: 'text' });
            res.data.split(/\r?\n/).forEach(line => {
                if (!line.trim()) return;
                try {
                    const obj = JSON.parse(line);
                    let clean = obj.text.trim().toLowerCase();
                    if (isValid(clean)) allWords.add(clean);
                } catch (e) {}
            });
        } catch (err) {}
    }

    try {
        const res = await axios.get(plainTextSource, { responseType: 'text' });
        res.data.split(/\r?\n/).forEach(line => {
            let clean = line.trim().toLowerCase();
            if (isValid(clean)) allWords.add(clean);
        });
    } catch (err) {}

    console.log('--- Xong! Tổng kho:', allWords.size, 'từ ---');
}

function findSuggestion(input, excluded = []) {
    const fullList = Array.from(allWords);

    let inPriority = Array.from(priorityWords).filter(w => w.startsWith(input + ' ') && !excluded.includes(w));
    let inAll = fullList.filter(w => w.startsWith(input + ' ') && !excluded.includes(w));

    // CHỈ ƯU TIÊN file data.json cá nhân
    let targetList = inPriority.length > 0 ? inPriority : inAll;

    if (targetList.length === 0) return null;

    const killWords = targetList.filter(w => {
        const nextStart = w.split(/\s+/)[1];
        return !fullList.some(n => n.startsWith(nextStart + ' '));
    });

    const result = killWords.length > 0 
        ? killWords[Math.floor(Math.random() * killWords.length)] 
        : targetList[Math.floor(Math.random() * targetList.length)];
    
    // Tag nhận biết: 💎 cho hàng JSON ưu tiên, ⭐ cho hàng Mongo
    let tag = '';
    if (priorityWords.has(result)) tag = ' 💎';
    else if (mongoWords.has(result)) tag = ' ⭐';

    return { 
        word: result, 
        isKill: killWords.includes(result),
        tag: tag
    };
}

const commands = [
    new SlashCommandBuilder()
        .setName('goiynoitu')
        .setDescription('Gợi ý nối từ')
        .addStringOption(opt => opt.setName('tu').setDescription('Từ đối phương nhập').setRequired(true)),
    new SlashCommandBuilder()
        .setName('train')
        .setDescription('Dạy bot từ mới (Lưu Mongo)')
        .addStringOption(opt => opt.setName('tu_moi').setDescription('Từ 2 tiếng').setRequired(true))
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

client.on('ready', async () => {
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
    console.log('🤖 Bot online! Ưu tiên data.json cá nhân.');
});

client.on('interactionCreate', async (interaction) => {
    if (interaction.isChatInputCommand()) {
        if (interaction.commandName === 'goiynoitu') {
            const input = interaction.options.getString('tu').trim().toLowerCase();
            await interaction.deferReply({ ephemeral: true });

            const history = [];
            const res = findSuggestion(input, history);
            if (!res) return await interaction.editReply(`Chịu, k nối nổi từ **${input}**`);

            history.push(res.word);
            suggestionHistory.set(interaction.id, { input, history });

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`other_${interaction.id}`).setLabel('Đổi từ khác').setStyle(ButtonStyle.Success)
            );

            await interaction.editReply({
                content: `Gợi ý: **${res.word}** ${res.isKill ? '🔥' : '✅'}${res.tag}`,
                components: [row]
            });
        }

        if (interaction.commandName === 'train') {
            const newWord = interaction.options.getString('tu_moi').trim().toLowerCase();
            if (!isValid(newWord)) return await interaction.reply({ content: 'Từ dỏm k nạp nhé', ephemeral: true });
            if (allWords.has(newWord)) return await interaction.reply({ content: 'có r', ephemeral: true });

            try {
                await WordModel.create({ text: newWord });
                allWords.add(newWord);
                mongoWords.add(newWord);
                await interaction.reply({ content: `Đã nạp **${newWord}** vào kho`, ephemeral: true });
            } catch (e) {
                await interaction.reply({ content: 'Lỗi rồi', ephemeral: true });
            }
        }
    }

    if (interaction.isButton()) {
        const oldId = interaction.customId.split('_')[1];
        const data = suggestionHistory.get(oldId);
        if (!data) return await interaction.reply({ content: 'Lệnh cũ r', ephemeral: true });

        await interaction.deferUpdate();
        const res = findSuggestion(data.input, data.history);
        if (!res) return await interaction.followUp({ content: 'Hết từ r!', ephemeral: true });

        data.history.push(res.word);
        await interaction.editReply({
            content: `Gợi ý: **${res.word}** ${res.isKill ? '🔥' : '✅'}${res.tag}`,
            components: [interaction.message.components[0]]
        });
    }
});

loadDict().then(() => client.login(process.env.TOKEN));

const express = require('express');
const app = express();
app.get('/', (req, res) => res.send('Bot đang chạy m ơi!'));
app.listen(process.env.PORT || 3000);