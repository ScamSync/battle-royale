require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, REST, Routes } = require('discord.js');
const mysql = require('mysql2/promise');
const fs = require('fs');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
    ],
});

const token = process.env.BOT_TOKEN;
const clientId = process.env.CLIENT_ID;

console.log('BOT_TOKEN:', token);
console.log('CLIENT_ID:', clientId);

const phrases = JSON.parse(fs.readFileSync('phrases.json', 'utf8'));

let connection;

async function initializeDatabase() {
    connection = await mysql.createConnection({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        port: process.env.DB_PORT,
        ssl: {
            rejectUnauthorized: false
        }
    });

    // Ensure game_data table has a row to update
    await connection.execute(`
        INSERT INTO game_data (id, total_servers, total_games_played)
        VALUES (1, 0, 0)
        ON DUPLICATE KEY UPDATE id=id
    `);
}

const games = new Map();

client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}!`);
    await updateTotalServers(client.guilds.cache.size);

    // Register slash commands
    const commands = [
        {
            name: 'startrr',
            description: 'Start a new Battle Royale game',
        },
        // Add other commands here
    ];

    const rest = new REST({ version: '10' }).setToken(token);

    (async () => {
        try {
            console.log('Started refreshing application (/) commands.');
            await rest.put(
                Routes.applicationCommands(clientId),
                { body: commands },
            );
            console.log('Successfully reloaded application (/) commands.');
        } catch (error) {
            console.error(error);
        }
    })();
});

client.on('guildCreate', async guild => {
    if (!games.has(guild.id)) {
        games.set(guild.id, createNewGame());
    }
    await updateTotalServers(client.guilds.cache.size);
});

client.on('guildDelete', async guild => {
    games.delete(guild.id);
    await updateTotalServers(client.guilds.cache.size);
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isCommand()) return;

    const { commandName, guildId } = interaction;

    if (!games.has(guildId)) {
        games.set(guildId, createNewGame());
    }

    const game = games.get(guildId);

    if (commandName === 'startrr') {
        try {
            await interaction.deferReply(); // Acknowledge the command immediately
            await interaction.followUp('Starting the Battle Royale game!');
            // Start the game logic here
            await startBattleRoyale(interaction, game);
        } catch (error) {
            console.error('Error handling interaction:', error);
            await interaction.followUp('There was an error while executing this command!');
        }
    }
});

function createNewGame() {
    return {
        gameInProgress: false,
        players: [],
        deadPlayers: [],
        killCounts: {},
        reviveCounts: {},
        gameCount: 0,
        serverCount: client.guilds.cache.size,
        gameId: null,
    };
}

async function startBattleRoyale(interaction, game) {
    if (game.gameInProgress) {
        return interaction.followUp('A game is already in progress!');
    }

    game.gameInProgress = true;
    game.players = [];
    game.deadPlayers = [];
    game.killCounts = {};
    game.reviveCounts = {};

    const startEmbed = new EmbedBuilder()
        .setTitle('React to this message within 90 seconds to join the game!')
        .setColor(0x00ff00);

    const gameMessage = await interaction.channel.send({ embeds: [startEmbed] });
    await gameMessage.react('👍');

    const filter = (reaction, user) => reaction.emoji.name === '👍' && !user.bot;
    const collector = gameMessage.createReactionCollector({ filter, time: 90000 });

    collector.on('collect', (reaction, user) => {
        if (!game.players.find(player => player.id === user.id)) {
            game.players.push({ id: user.id, username: interaction.guild.members.cache.get(user.id).displayName });
            game.killCounts[user.id] = 0;
            game.reviveCounts[user.id] = 0;
        }
    });

    collector.on('end', async () => {
        if (game.players.length < 2) {
            await interaction.followUp('Not enough players joined the game.');
            game.gameInProgress = false;
        } else {
            const playerMentions = game.players.map(player => `<@${player.id}>`).join(', ');
            const startEmbed = new EmbedBuilder()
                .setTitle('The game is about to start!')
                .setDescription(`Players: ${playerMentions}`)
                .setColor(0xffa500);

            await interaction.followUp({ embeds: [startEmbed] });
            game.gameId = await createGame(interaction.guild.id);
            setTimeout(() => playRound(interaction.channel, 1, game), 5000);
        }
    });
}

async function playRound(channel, round, game) {
    try {
        console.log(`Starting round ${round}`);

        const roundStartTime = Date.now();
        const maxRoundDuration = 60000; // 60 seconds

        if (game.players.length <= 1) {
            if (game.players.length === 1) {
                await channel.send(`<@${game.players[0].id}> is the winner!`);
            } else {
                await channel.send('No winners this time.');
            }
            await displayResults(channel, game);
            game.gameInProgress = false;
        } else {
            const eliminated = [];
            const roundEmbed = new EmbedBuilder()
                .setTitle(`Round ${round}`)
                .setColor(0xff0000)
                .setFooter({ text: `Game ID: ${game.gameId}` });

            for (let player of game.players) {
                if (eliminated.includes(player)) continue;

                let phrase = phrases[Math.floor(Math.random() * phrases.length)];
                if (phrase.includes('<target>')) {
                    let target;
                    do {
                        target = game.players.filter(p => p.id !== player.id && !eliminated.includes(p))[Math.floor(Math.random() * game.players.length)];
                    } while (!target || target.id === player.id);
                    phrase = phrase.replace(/<target>/g, `**${target.username}**`);
                }

                // Check for death keywords
                const deathKeywords = ['died', 'buried', 'killed', 'drowned', 'fatally', 'crushed', 'death', 'impaled'];
                const deathOccurred = deathKeywords.some(keyword => phrase.includes(keyword));

                if (deathOccurred) {
                    phrase = phrase.replace('<username>', `${player.username}`);
                    eliminated.push(player);

                    // Replace <killer> with another player's name if present and if the killer is still alive
                    if (phrase.includes('<killer>')) {
                        let killer;
                        do {
                            killer = game.players.filter(p => p.id !== player.id && !eliminated.includes(p))[Math.floor(Math.random() * game.players.length)];
                        } while (!killer || killer.id === player.id);
                        phrase = phrase.replace(/<killer>/g, `**${killer.username}**`);
                        game.killCounts[killer.id]++;
                    }
                } else {
                    phrase = phrase.replace('<username>', `**${player.username}**`);

                    // Replace <killer> with another player's name if present
                    if (phrase.includes('<killer>')) {
                        let killer;
                        do {
                            killer = game.players.filter(p => p.id !== player.id && !eliminated.includes(p))[Math.floor(Math.random() * game.players.length)];
                        } while (!killer || killer.id === player.id);
                        phrase = phrase.replace(/<killer>/g, `**${killer.username}**`);
                    }
                }

                roundEmbed.addFields({ name: '\u200B', value: phrase });
            }

            game.players = game.players.filter(player => !eliminated.includes(player));
            game.deadPlayers.push(...eliminated);

            const playersLeft = game.players.map(player => player.username).join(', ');

            if (playersLeft) {
                roundEmbed.addFields({ name: 'Players left', value: playersLeft });
            }

            await channel.send({ embeds: [roundEmbed] });

            // Small chance for revival
            if (Math.random() < 0.1 && game.deadPlayers.length > 0) { // 10% chance
                const revivedPlayerIndex = Math.floor(Math.random() * game.deadPlayers.length);
                const revivedPlayer = game.deadPlayers.splice(revivedPlayerIndex, 1)[0];
                game.players.push(revivedPlayer);
                game.reviveCounts[revivedPlayer.id]++;
                await channel.send(`:angel: **${revivedPlayer.username}** has been revived!`);
            }

            const elapsedTime = Date.now() - roundStartTime;
            console.log(`Round ${round} completed in ${elapsedTime}ms`);

            if (elapsedTime > maxRoundDuration) {
                await channel.send('The round took too long! Moving on to the next round...');
            }

            setTimeout(() => playRound(channel, round + 1, game), 10000);
        }
    } catch (error) {
        console.error(`Error in round ${round}:`, error);
    }
}

async function displayResults(channel, game) {
    try {
        console.log('Displaying results');
        // Sort players by most kills
        const sortedKillCounts = Object.entries(game.killCounts).sort((a, b) => b[1] - a[1]);
        const topKillers = sortedKillCounts.slice(0, 3).map(([id, count]) => `<@${id}> with ${count} kills`);

        const sortedReviveCounts = Object.entries(game.reviveCounts).sort((a, b) => b[1] - a[1]);
        const topRevivers = sortedReviveCounts.slice(0, 3).map(([id, count]) => `<@${id}> with ${count} revives`);

        const topSurvivors = game.deadPlayers.slice(-3).reverse().map(player => player.username);

        const resultEmbed = new EmbedBuilder()
            .setTitle('Game Results')
            .setColor(0x0000ff)
            .addFields(
                { name: 'Runners Up', value: topSurvivors.length > 0 ? topSurvivors.join(', ') : 'None' },
                { name: 'Most Kills', value: topKillers.length > 0 ? topKillers.join(', ') : 'None' },
                { name: 'Most Revives', value: topRevivers.length > 0 ? topRevivers.join(', ') : 'None' }
            )
            .setFooter({ text: `Game ID: ${game.gameId}` });

        await channel.send({ embeds: [resultEmbed] });

        // Update leaderboard
        for (const player of game.players) {
            await updateLeaderboard(player, channel.guild.id, 0, game.killCounts[player.id], game.reviveCounts[player.id]);
        }
        for (const player of game.deadPlayers) {
            await updateLeaderboard(player, channel.guild.id, 0, game.killCounts[player.id], game.reviveCounts[player.id]);
        }
        if (game.players.length === 1) {
            await updateLeaderboard(game.players[0], channel.guild.id, 1, 0, 0); // Increment win count for the winner
        }

        game.gameCount++;
        game.gameInProgress = false; // Ensure game state is reset after results are displayed
        game.players = [];
        game.deadPlayers = [];
        game.killCounts = {};
        game.reviveCounts = {};
        await incrementGamesPlayed();

        // Update the game record with the winner ID
        if (game.players.length === 1) {
            await updateGameWinner(game.gameId, game.players[0].id);
        }
    } catch (error) {
        console.error('Error displaying results:', error);
    }
}

// Simulate game for testing
async function simulateGame(gamesToSimulate = 10) {
    const guildId = '1260134748999913553';
    const channelId = '1269581741895450645';

    for (let i = 0; i < gamesToSimulate; i++) {
        const testGame = createNewGame();
        testGame.players = [
            { id: '1', username: 'Dan' },
            { id: '2', username: 'Jack' },
            { id: '3', username: 'Emma' },
            { id: '4', username: 'Jennifer' },
            { id: '5', username: 'Leanna' },
            { id: '6', username: 'John' },
            { id: '7', username: 'Richard' },
            { id: '8', username: 'Lee' }
        ];
        testGame.players.forEach(player => {
            testGame.killCounts[player.id] = 0;
            testGame.reviveCounts[player.id] = 0;
        });
        console.log(`Starting simulated game ${i + 1}...`);

        try {
            const guild = await client.guilds.fetch(guildId);
            const channel = await guild.channels.fetch(channelId);

            if (!guild) {
                console.error('Guild not found');
                return;
            }

            if (!channel) {
                console.error('Channel not found');
                return;
            }

            await playRound(channel, 1, testGame);

            // Wait for the game to finish before starting the next one
            while (testGame.gameInProgress) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        } catch (error) {
            console.error('Error fetching guild or channel:', error);
        }
    }
}

// Add leaderboard update function
async function updateLeaderboard(player, guildId, wins = 0, kills = 0, revives = 0) {
    try {
        const [rows] = await connection.execute(
            `INSERT INTO leaderboard (user_id, username, guild_id, wins, kills, revives)
             VALUES (?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
             wins = wins + VALUES(wins),
             kills = kills + VALUES(kills),
             revives = revives + VALUES(revives)`,
            [player.id, player.username, guildId, wins, kills, revives]
        );
        console.log(`Leaderboard updated for ${player.username}`);
    } catch (error) {
        console.error('Error updating leaderboard:', error);
    }
}

async function createGame(guildId) {
    try {
        const [rows] = await connection.execute(
            `INSERT INTO games (guild_id) VALUES (?)`,
            [guildId]
        );
        const gameId = rows.insertId;
        console.log('Game created with ID:', gameId);
        return gameId;
    } catch (error) {
        console.error('Error creating game:', error);
    }
}

async function updateGameWinner(gameId, winnerId) {
    try {
        await connection.execute(
            `UPDATE games SET winner_id = ? WHERE game_id = ?`,
            [winnerId, gameId]
        );
        console.log('Updated game with winner ID:', winnerId);
    } catch (error) {
        console.error('Error updating game winner:', error);
    }
}

async function updateTotalServers(totalServers) {
    try {
        await connection.execute(
            `UPDATE game_data SET total_servers = ? WHERE id = 1`,
            [totalServers]
        );
        console.log('Total servers updated to:', totalServers);
    } catch (error) {
        console.error('Error updating total servers:', error);
    }
}

async function incrementGamesPlayed() {
    try {
        await connection.execute(
            `UPDATE game_data SET total_games_played = total_games_played + 1 WHERE id = 1`
        );
        console.log('Incremented total games played');
    } catch (error) {
        console.error('Error incrementing total games played:', error);
    }
}

async function main() {
    await initializeDatabase();
    client.login(token).then(() => {
        // Uncomment the line below to run the simulation
        // simulateGame(1);
    }).catch(console.error);
}

main().catch(console.error);
