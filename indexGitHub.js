const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionsBitField
} = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent
  ]
});

// ================= CONFIG =================
const PRIORITY_ROLES = ["Revolutionists"]; // roles that give priority
const MAX_STACK = 5;
const VOICE_CHANNEL_ID = "Discord Voice ID"; // your VC ID

// ================= STATE =================
let priorityQueue = [];
let normalQueue = [];
let activeStack = [];
let queueMessage = null;

// ================= QUEUE HELPERS =================
function isInQueue(id) {
  return priorityQueue.includes(id) || normalQueue.includes(id);
}

function removeUser(id) {
  priorityQueue = priorityQueue.filter(x => x !== id);
  normalQueue = normalQueue.filter(x => x !== id);
  activeStack = activeStack.filter(x => x !== id);
}

function getQueue() {
  return [...priorityQueue, ...normalQueue];
}

// ================= ROLE CHECK =================
function isPriority(member) {
  return member.roles.cache.some(r => PRIORITY_ROLES.includes(r.name));
}

// ================= EMBED =================
function createEmbed(guild) {
  const stackText = activeStack.length
    ? activeStack.map((id, i) => {
        const m = guild.members.cache.get(id);
        return `**${i + 1}.** ${m ? m.user.username : "Unknown"}`;
      }).join("\n")
    : "No active stack.";

  const queueText = getQueue().length
    ? getQueue().map((id, i) => {
        const m = guild.members.cache.get(id);
        return `**${i + 1}.** ${m ? m.user.username : "Unknown"}`;
      }).join("\n")
    : "Empty.";

  return new EmbedBuilder()
    .setTitle("Queue System")
    .addFields(
      { name: "Active 5 Stack", value: stackText },
      { name: "Waiting Queue", value: queueText }
    )
    .setColor(0x00AE86);
}

// ================= BUTTONS =================
function getButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('join').setLabel('Join').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('leave').setLabel('Leave').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('skip').setLabel('Skip').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('clear').setLabel('Clear').setStyle(ButtonStyle.Secondary)
  );
}

// ================= STACK FILL =================
function fillStack(guild) {
  while (activeStack.length < MAX_STACK) {
    let next = null;
    if (priorityQueue.length > 0) next = priorityQueue.shift();
    else if (normalQueue.length > 0) next = normalQueue.shift();
    if (!next) break;
    activeStack.push(next);
    if (queueMessage) {
      const textChannel = guild.channels.cache.get(queueMessage.channelId);
      if (textChannel) textChannel.send(`<@${next}> you're up! Join the call!`);
    }
  }
}

// ================= PRIORITY REPLACEMENT =================
async function reorderStackByPriority(guild) {
  if (!queueMessage) return;

  let activeMembers = activeStack.map(id => guild.members.cache.get(id)).filter(Boolean);
  let queueMembers = [...priorityQueue, ...normalQueue].map(id => guild.members.cache.get(id)).filter(Boolean);

  let changed = false;

  for (let qm of queueMembers) {
    if (!isPriority(qm)) continue;
    const replaceIndex = activeMembers.findIndex(m => !isPriority(m));
    if (replaceIndex === -1) break; // no low-priority to replace

    const replaced = activeStack[replaceIndex];
    activeStack[replaceIndex] = qm.id;
    removeUser(qm.id); // remove from queue
    normalQueue.push(replaced); // displaced user goes back to queue
    changed = true;
  }

  fillStack(guild);
  if (changed) refreshQueueEmbed(queueMessage.channel);
}

// ================= REFRESH QUEUE MESSAGE =================
async function refreshQueueEmbed(channel) {
  if (!queueMessage) return;
  try {
    await queueMessage.delete().catch(() => {});
    queueMessage = await channel.send({
      embeds: [createEmbed(channel.guild)],
      components: [getButtons()]
    });
  } catch (err) {
    console.error("Failed to refresh queue embed:", err);
  }
}

// ================= VOICE STATE =================
client.on('voiceStateUpdate', async (oldState, newState) => {
  const channel = newState.guild.channels.cache.get(VOICE_CHANNEL_ID);
  if (!channel) return;

  if (oldState.channelId === VOICE_CHANNEL_ID && (!newState.channelId || newState.channelId !== VOICE_CHANNEL_ID)) {
    removeUser(oldState.member.id);
  }

  if (newState.channelId === VOICE_CHANNEL_ID) {
    removeUser(newState.member.id);
  }

  fillStack(newState.guild);
  if (queueMessage) refreshQueueEmbed(queueMessage.channel);
});

// ================= BUTTON HANDLER =================
client.on('interactionCreate', async interaction => {
  if (!interaction.isButton()) return;

  const member = interaction.member;
  const id = member.id;

  if (interaction.customId === 'join') {
  if (isInQueue(id) || activeStack.includes(id)) {
    return interaction.reply({ content: "Already in system.", ephemeral: true });
  }

  const hasPriority = isPriority(member);
  if (hasPriority) priorityQueue.push(id);
  else normalQueue.push(id);

  // Reorder stack so priority members replace lower-priority if needed
  await reorderStackByPriority(interaction.guild);

  // Fill any empty spots in stack
  fillStack(interaction.guild);

  // Delete old queue message and send a new one at the bottom
  if (queueMessage) await refreshQueueEmbed(queueMessage.channel);

  // Acknowledge the button click
  await interaction.deferUpdate();
}

  if (interaction.customId === 'leave') {
    removeUser(id);
    await interaction.deferUpdate();
    if (queueMessage) refreshQueueEmbed(queueMessage.channel);
  }

  if (interaction.customId === 'skip') {
    if (!member.permissions.has(PermissionsBitField.Flags.Administrator))
      return interaction.reply({ content: "Admins only.", ephemeral: true });

    activeStack.shift();
    fillStack(interaction.guild);
    await interaction.deferUpdate();
    if (queueMessage) refreshQueueEmbed(queueMessage.channel);
  }

  if (interaction.customId === 'clear') {
    if (!member.permissions.has(PermissionsBitField.Flags.Administrator))
      return interaction.reply({ content: "Admins only.", ephemeral: true });

    priorityQueue = [];
    normalQueue = [];
    activeStack = [];
    await interaction.deferUpdate();
    if (queueMessage) refreshQueueEmbed(queueMessage.channel);
  }
});

// ================= ADMIN COMMANDS & QUEUE TRIGGER =================
client.on('messageCreate', async message => {
  if (message.author.bot) return;

  const member = message.member;
  const channel = message.channel;

  // Update queue UI when someone sends a message in #ranked-queue
  if (channel.name === "ranked-queue") {
    if (queueMessage) await queueMessage.delete().catch(() => {});
    queueMessage = await channel.send({
      embeds: [createEmbed(message.guild)],
      components: [getButtons()]
    });
  }

  if (!member.permissions.has(PermissionsBitField.Flags.Administrator)) return;

  // Add user to active stack
  if (message.content.startsWith('!add')) {
    const user = message.mentions.members.first();
    if (!user) return;
    removeUser(user.id);

    const hasPriority = isPriority(user);
    if (activeStack.length < MAX_STACK) {
      activeStack.push(user.id);
    } else if (hasPriority) {
      // replace lowest priority if necessary
      await reorderStackByPriority(message.guild);
      fillStack(message.guild);
    } else {
      // goes to queue
      normalQueue.push(user.id);
    }

    message.channel.send(`✅ ${user.user.username} added according to role priority`);
    if (queueMessage) refreshQueueEmbed(channel);
  }

  // Remove user from stack/queue
  if (message.content.startsWith('!remove')) {
    const user = message.mentions.members.first();
    if (!user) return;
    removeUser(user.id);
    message.channel.send(`✅ ${user.user.username} removed from queue/stack`);
    if (queueMessage) refreshQueueEmbed(channel);
  }

  // Skip first active stack member
  if (message.content === '!skip') {
    activeStack.shift();
    fillStack(message.guild);
    message.channel.send(`✅ Skipped first member in stack`);
    if (queueMessage) refreshQueueEmbed(channel);
  }

  // Clear all queues
  if (message.content === '!clear') {
    priorityQueue = [];
    normalQueue = [];
    activeStack = [];
    message.channel.send(`✅ Cleared all queues`);
    if (queueMessage) refreshQueueEmbed(channel);
  }
});

// ================= LOGIN =================
client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}!`);
});

client.login('Discord Bot Token');