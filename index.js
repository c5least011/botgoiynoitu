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
let allWords = new Set(); // Tổng kho
let mongoWords = new Set(); // Chỉ hàng m train
const suggestionHistory = new Map();

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
    
    // 1. Load từ MongoDB
    try {
        const dbWords = await WordModel.find();
        dbWords.forEach(w => {
            allWords.add(w.text);
            mongoWords.add(w.text);
        });
        console.log(`✅ Đã nạp ${dbWords.length} từ từ MongoDB.`);
    } catch (err) { console.log('❌ Lỗi nạp Mongo:', err.message); }

    // 2. Load JSONL Sources (GitHub)
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

    let availableInMongo = Array.from(mongoWords).filter(w => w.startsWith(input + ' ') && !excluded.includes(w));
    let availableInAll = fullList.filter(w => w.startsWith(input + ' ') && !excluded.includes(w));
    let targetList = availableInMongo.length > 0 ? availableInMongo : availableInAll;

    if (targetList.length === 0) return null;

    const killWords = targetList.filter(w => {
        const nextStart = w.split(/\s+/)[1];
        return !fullList.some(n => n.startsWith(nextStart + ' '));
    });

    const result = killWords.length > 0 
        ? killWords[Math.floor(Math.random() * killWords.length)] 
        : targetList[Math.floor(Math.random() * targetList.length)];
    
    const fromMongo = mongoWords.has(result);

    return { 
        word: result, 
        isKill: killWords.includes(result),
        fromMongo: fromMongo
    };
}

const commands = [
    new SlashCommandBuilder()
        .setName('goiynoitu')
        .setDescription('Gợi ý nối từ')
        .addStringOption(opt => opt.setName('tu').setDescription('Từ đối phương nhập').setRequired(true)),
    new SlashCommandBuilder()
        .setName('train')
        .setDescription('Dạy bot từ mới')
        .addStringOption(opt => opt.setName('tu_moi').setDescription('Từ 2 tiếng').setRequired(true))
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

client.on('ready', async () => {
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
    console.log('🤖 Bot online! Đã sẵn sàng nã đạn.');
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
                content: `Gợi ý: **${res.word}** ${res.isKill ? '🔥' : '✅'}${res.fromMongo ? '⭐' : ''}`,
                components: [row]
            });
        }

        if (interaction.commandName === 'train') {
            const newWord = interaction.options.getString('tu_moi').trim().toLowerCase();
            if (!isValid(newWord)) return await interaction.reply({ content: 'Từ dỏm k nạp nhé', ephemeral: true });
            if (mongoWords.has(newWord)) return await interaction.reply({ content: 'có r', ephemeral: true });

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
            content: `Gợi ý: **${res.word}** ${res.isKill ? '🔥' : '✅'}${res.fromMongo ? ' ⭐' : ''}`,
            components: [interaction.message.components[0]]
        });
    }
});

loadDict().then(() => client.login(process.env.TOKEN));

const express = require('express');
const app = express();
app.get('/', (req, res) => res.send('Bot đang chạy m ơi!'));
app.listen(process.env.PORT || 3000);