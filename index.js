require('dotenv').config();
const { 
    Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, 
    ActionRowBuilder, ButtonBuilder, ButtonStyle 
} = require('discord.js');
const axios = require('axios');
const mongoose = require('mongoose');

mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ Đã thông nòng MongoDB'))
    .catch(err => console.error('❌ Lỗi DB:', err));

const WordSchema = new mongoose.Schema({ text: { type: String, unique: true } });
const WordModel = mongoose.model('Word', WordSchema);

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
let priorityWords = new Set(); // ƯU TIÊN SỐ 1
let otherWords = new Set();    // HÀNG BÌNH ĐẲNG (Mongo + Public)
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
    priorityWords.clear();
    otherWords.clear();
    
    // 1. Load ƯU TIÊN SỐ 1
    try {
        const res = await axios.get(PRIORITY_SOURCE);
        let rawData = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
        let data = JSON.parse(rawData.replace(/“|”/g, '"'));
        if (Array.isArray(data)) {
            data.forEach(w => {
                let clean = w.trim().toLowerCase();
                if (isValid(clean)) priorityWords.add(clean);
            });
            console.log(`✅ Đã nạp ${priorityWords.size} từ ƯU TIÊN.`);
        }
    } catch (err) { console.log('❌ Lỗi nạp source cá nhân'); }

    // 2. Load MongoDB
    try {
        const dbWords = await WordModel.find();
        dbWords.forEach(w => {
            let clean = w.text.trim().toLowerCase();
            if (isValid(clean)) otherWords.add(clean);
        });
        console.log(`✅ Đã nạp ${dbWords.length} từ từ MongoDB.`);
    } catch (err) { console.log('❌ Lỗi nạp Mongo'); }

    // 3. Load Public GitHub
    for (const url of jsonSources) {
        try {
            const res = await axios.get(url, { responseType: 'text' });
            res.data.split(/\r?\n/).forEach(line => {
                if (!line.trim()) return;
                try {
                    const obj = JSON.parse(line);
                    let clean = obj.text.trim().toLowerCase();
                    if (isValid(clean)) otherWords.add(clean);
                } catch (e) {}
            });
        } catch (err) {}
    }

    try {
        const res = await axios.get(plainTextSource, { responseType: 'text' });
        res.data.split(/\r?\n/).forEach(line => {
            let clean = line.trim().toLowerCase();
            if (isValid(clean)) otherWords.add(clean);
        });
    } catch (err) {}

    console.log(`--- Xong! Tổng kho: ${priorityWords.size + otherWords.size} từ ---`);
}

function findSuggestion(input, excluded = []) {
    // Check hàng Ưu tiên trước
    let availableInPriority = Array.from(priorityWords).filter(w => w.startsWith(input + ' ') && !excluded.includes(w));
    
    // Check hàng Thường (Mongo + Public)
    let availableInOther = Array.from(otherWords).filter(w => w.startsWith(input + ' ') && !excluded.includes(w));

    // Chọn list mục tiêu
    let targetList = availableInPriority.length > 0 ? availableInPriority : availableInOther;
    if (targetList.length === 0) return null;

    // Gộp tất cả để check sát chiêu
    const combined = new Set([...priorityWords, ...otherWords]);
    const killWords = targetList.filter(w => {
        const nextStart = w.split(/\s+/)[1];
        return !Array.from(combined).some(n => n.startsWith(nextStart + ' '));
    });

    const result = killWords.length > 0 
        ? killWords[Math.floor(Math.random() * killWords.length)] 
        : targetList[Math.floor(Math.random() * targetList.length)];
    
    // Gắn tag chuẩn:💎 là JSON Ưu tiên, k có tag là hàng thường
    let tag = priorityWords.has(result) ? ' 💎' : '';

    return { word: result, isKill: killWords.includes(result), tag };
}

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
            if (!isValid(newWord)) return await interaction.reply({ content: 'Từ dỏm k nạp!', ephemeral: true });
            if (priorityWords.has(newWord) || otherWords.has(newWord)) return await interaction.reply({ content: 'có r', ephemeral: true });

            try {
                await WordModel.create({ text: newWord });
                otherWords.add(newWord);
                await interaction.reply({ content: `Đã nạp **${newWord}** vào Mongo (Hàng thường)`, ephemeral: true });
            } catch (e) { await interaction.reply({ content: 'Lỗi rồi', ephemeral: true }); }
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

const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
client.on('ready', async () => {
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: [
        new SlashCommandBuilder().setName('goiynoitu').setDescription('Gợi ý nối từ').addStringOption(opt => opt.setName('tu').setRequired(true)),
        new SlashCommandBuilder().setName('train').setDescription('Dạy bot').addStringOption(opt => opt.setName('tu_moi').setRequired(true))
    ].map(c => c.toJSON()) });
    console.log('🤖 Bot đã tỉnh táo!');
});

loadDict().then(() => client.login(process.env.TOKEN));
const express = require('express');
const app = express();
app.get('/', (req, res) => res.send('Bot chạy r m!'));
app.listen(process.env.PORT || 3000);