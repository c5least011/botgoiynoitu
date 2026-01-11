// require
require('dotenv').config();
const { 
    Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, 
    ActionRowBuilder, ButtonBuilder, ButtonStyle 
} = require('discord.js');
const axios = require('axios');
const mongoose = require('mongoose');
// setup DB
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ Đã thông nòng MongoDB'))
    .catch(err => console.error('❌ Lỗi DB:', err));

const WordSchema = new mongoose.Schema({ text: { type: String, unique: true } });
const WordModel = mongoose.model('Word', WordSchema);

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
let priorityWords = new Set(); 
let otherWords = new Set();    
const suggestionHistory = new Map();
// source
const PRIORITY_SOURCE = 'https://raw.githubusercontent.com/c5least011/botgoiynoitu/refs/heads/main/data.json';
const jsonSources = [
    'https://raw.githubusercontent.com/undertheseanlp/dictionary/refs/heads/wiktionary/dictionary/words.txt',
    'https://raw.githubusercontent.com/undertheseanlp/dictionary/refs/heads/tudientv/dictionary/words.txt',
    'https://raw.githubusercontent.com/undertheseanlp/dictionary/refs/heads/hongocduc/dictionary/words.txt'
];
const plainTextSource = 'https://raw.githubusercontent.com/lvdat/phobo-contribute-words/refs/heads/main/accepted-words.txt';
// filter
function isValid(w) {
    if (!w || w.includes(':') || w.includes('*') || w.includes('-')) return false;
    return w.split(/\s+/).length === 2;
}
// load filtered
async function loadDict() {
    console.log('--- Đang quét kho vũ khí ---');
    priorityWords.clear();
    otherWords.clear();
    
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

    try {
        const dbWords = await WordModel.find();
        dbWords.forEach(w => {
            let clean = w.text.trim().toLowerCase();
            if (isValid(clean)) otherWords.add(clean);
        });
        console.log(`✅ Đã nạp ${dbWords.length} từ từ MongoDB.`);
    } catch (err) { console.log('❌ Lỗi nạp Mongo'); }

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
// get input
function findSuggestion(input, excluded = []) {
    let availableInPriority = Array.from(priorityWords).filter(w => w.startsWith(input + ' ') && !excluded.includes(w));
    let availableInOther = Array.from(otherWords).filter(w => w.startsWith(input + ' ') && !excluded.includes(w));

    let targetList = availableInPriority.length > 0 ? availableInPriority : availableInOther;
    if (targetList.length === 0) return null;

    const combined = new Set([...priorityWords, ...otherWords]);
    const killWords = targetList.filter(w => {
        const nextStart = w.split(/\s+/)[1];
        return !Array.from(combined).some(n => n.startsWith(nextStart + ' '));
    });

    const result = killWords.length > 0 
        ? killWords[Math.floor(Math.random() * killWords.length)] 
        : targetList[Math.floor(Math.random() * targetList.length)];
    
    let tag = priorityWords.has(result) ? ' 💎' : '';
    return { word: result, isKill: killWords.includes(result), tag };
}
// goiynoitu function
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
// train function
        if (interaction.commandName === 'train') {
            const newWord = interaction.options.getString('tu_moi').trim().toLowerCase();
            if (!isValid(newWord)) return await interaction.reply({ content: 'Từ dỏm k nạp!', ephemeral: true });
            if (priorityWords.has(newWord) || otherWords.has(newWord)) return await interaction.reply({ content: 'có r', ephemeral: true });

            try {
                await WordModel.create({ text: newWord });
                otherWords.add(newWord);
                await interaction.reply({ content: `Đã nạp **${newWord}**`, ephemeral: true });
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
// slash cmds
client.on('ready', async () => {
    const commands = [
        new SlashCommandBuilder()
            .setName('goiynoitu')
            .setDescription('Gợi ý nối từ')
            .addStringOption(opt => 
                opt.setName('tu')
                   .setDescription('Từ cần nối')
                   .setRequired(true)
            ),
        new SlashCommandBuilder()
            .setName('train')
            .setDescription('Dạy bot từ mới')
            .addStringOption(opt => 
                opt.setName('tu_moi')
                   .setDescription('Từ 2 tiếng') 
                   .setRequired(true)
            )
    ].map(c => c.toJSON());

    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
    console.log('🤖 Bot đã tỉnh táo!');
});
// login bot
const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
loadDict().then(() => client.login(process.env.TOKEN));
// port
const express = require('express');
const app = express();
app.get('/', (req, res) => res.send('Bot chạy r m!'));
app.listen(process.env.PORT || 3000);
