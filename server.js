/* ------------------------------------------------------------------ *
 *  MAFIA — GOD SERVER
 *  The server is the single source of truth. It holds every secret
 *  (who is mafia, who the doctor saved, detective results) and only
 *  ever sends each connected socket the slice it is allowed to see.
 *  Browsers are never trusted with hidden information.
 * ------------------------------------------------------------------ */

const path = require('path');
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

/* ----------------------------- state ------------------------------ */
// rooms are kept in memory for speed, but mirrored to disk so a server
// restart (crash, deploy, reboot) doesn't wipe an in-progress game.
// Players reconnect via a persistent token (see rejoinRoom) rather than
// their socket id, which changes every time they reconnect.
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'rooms.json');

// A room written by an older build can be missing fields this build expects
// (e.g. night.investigations was renamed to night.detectiveVotes). Restoring
// one unmigrated would crash buildView and take the live game down, so
// normalize every restored room up to the current shape.
function normalizeNight(night) {
  if (!night) return null;
  const doctorVotes = night.doctorVotes || night.doctorChoiceBy || {};
  // an older build recorded only the last doctor's pick in saveTarget —
  // carry it forward as a vote so a mid-game deploy doesn't lose the save
  if (!Object.keys(doctorVotes).length && night.saveTarget) doctorVotes.__legacy = night.saveTarget;
  return {
    mafiaVotes: night.mafiaVotes || {},
    doctorVotes,
    detectiveVotes: night.detectiveVotes || night.investigations || {},
  };
}

function loadRooms() {
  try {
    const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    for (const room of Object.values(saved)) {
      // sockets from the previous process are all gone — everyone is
      // "disconnected" until their browser rejoins with its saved token.
      for (const p of Object.values(room.players || {})) p.connected = false;
      room.night = normalizeNight(room.night);
      if (room.phase === 'night' && !room.night) room.night = normalizeNight({});
    }
    return saved;
  } catch {
    return {};
  }
}

function saveRooms() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(rooms));
}

const rooms = loadRooms(); // code -> room

const ROLE = { MAFIA: 'mafia', DOCTOR: 'doctor', DETECTIVE: 'detective', VILLAGER: 'villager' };

// Every night role acts as a team: one shared decision per night, and
// teammates recognize each other. Only villagers have no night team.
function isTeamRole(role) {
  return role === ROLE.MAFIA || role === ROLE.DETECTIVE || role === ROLE.DOCTOR;
}
function teammatesOf(room, player) {
  if (!isTeamRole(player.role)) return [];
  return playersArr(room)
    .filter((p) => p.role === player.role && p.id !== player.id)
    .map((p) => p.name);
}

function makeCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no confusing chars
  let code;
  do {
    code = Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  } while (rooms[code]);
  return code;
}

function normalizePhone(raw) {
  if (!raw) return '';
  let d = String(raw).replace(/\D/g, ''); // digits only (drops +, spaces, dashes)
  d = d.replace(/^00/, '');               // strip international 00 prefix
  return d.slice(0, 15);
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function playersArr(room) {
  return room.order.map((id) => room.players[id]).filter(Boolean);
}
function alivePlayers(room) {
  return playersArr(room).filter((p) => p.alive);
}
function aliveOf(room, role) {
  return alivePlayers(room).filter((p) => p.role === role);
}

/* ------------------------- view building -------------------------- */
// A "spectator" (host or dead player) sees everything, including roles.
// A living player sees names + alive status + their own role only
// (mafia additionally see their fellow mafia).
function buildView(room, socketId) {
  const me = room.players[socketId];
  const isHost = socketId === room.hostId;
  const amDead = me ? !me.alive : false;
  const spectator = isHost || amDead;

  const roster = playersArr(room).map((p) => {
    const showRole =
      spectator ||
      (me && p.id === me.id) ||
      // teammates recognize each other — mafia know their fellow mafia,
      // detectives know their fellow detectives
      (me && me.alive && isTeamRole(me.role) && p.role === me.role);
    return {
      id: p.id,
      name: p.name,
      alive: p.alive,
      connected: p.connected,
      role: showRole ? p.role : null,
      phone: isHost ? p.phone || null : undefined, // numbers never leak to players
    };
  });

  // For the host, show live night progress (who has acted) without leaking
  // more than needed. Players only ever get their own action prompt.
  let nightStatus = null;
  if (isHost && room.phase === 'night') {
    // defensive: never let a malformed night object crash the whole host view
    const n = room.night || {};
    nightStatus = {
      mafiaVoted: Object.keys(n.mafiaVotes || {}).length,
      mafiaTotal: aliveOf(room, ROLE.MAFIA).length,
      doctorActed: Object.keys(n.doctorVotes || {}).length,
      doctorTotal: aliveOf(room, ROLE.DOCTOR).length,
      detectiveActed: Object.keys(n.detectiveVotes || {}).length,
      detectiveTotal: aliveOf(room, ROLE.DETECTIVE).length,
    };
  }

  // My personal night action prompt (living players with a night role).
  let myAction = null;
  if (me && me.alive && room.phase === 'night') {
    const n = room.night || {};
    if (me.role === ROLE.MAFIA) {
      myAction = { type: ROLE.MAFIA, chosen: n.mafiaVotes?.[me.id] || null };
    } else if (me.role === ROLE.DOCTOR) {
      myAction = { type: ROLE.DOCTOR, chosen: n.doctorVotes?.[me.id] || null };
    } else if (me.role === ROLE.DETECTIVE) {
      myAction = { type: ROLE.DETECTIVE, chosen: n.detectiveVotes?.[me.id] || null };
    }
  }

  return {
    code: room.code,
    phase: room.phase,
    round: room.round,
    config: room.config,
    isHost,
    spectator,
    winner: room.winner,
    you: me ? { id: me.id, name: me.name, role: me.role, alive: me.alive } : null,
    roster,
    counts: {
      alive: alivePlayers(room).length,
      mafiaAlive: aliveOf(room, ROLE.MAFIA).length,
      townAlive: alivePlayers(room).length - aliveOf(room, ROLE.MAFIA).length,
    },
    nightStatus,
    myAction,
    narration: room.narration.slice(-30),
    lastNight: room.lastNight, // summary of what happened at the most recent resolution
  };
}

function pushState(room) {
  // send a tailored view to every connected socket in the room
  const ids = [room.hostId, ...room.order];
  for (const id of ids) {
    if (!id) continue;
    io.to(id).emit('state', buildView(room, id));
  }
  saveRooms();
}

function narrate(room, text) {
  room.narration.push({ t: Date.now(), text });
}

/* ------------------------- game mechanics ------------------------- */
function assignRoles(room) {
  const players = playersArr(room);
  const { mafia, doctor, detective } = room.config;
  const villagers = players.length - mafia - doctor - detective;

  const bag = [];
  for (let i = 0; i < mafia; i++) bag.push(ROLE.MAFIA);
  for (let i = 0; i < doctor; i++) bag.push(ROLE.DOCTOR);
  for (let i = 0; i < detective; i++) bag.push(ROLE.DETECTIVE);
  for (let i = 0; i < villagers; i++) bag.push(ROLE.VILLAGER);
  shuffle(bag);

  players.forEach((p, i) => (p.role = bag[i]));

  // tell each player their role privately; mafia and detectives also learn their team
  for (const p of players) {
    io.to(p.id).emit('youAre', { role: p.role, teammates: teammatesOf(room, p) });
  }
}

function startNight(room) {
  room.phase = 'night';
  room.round += 1;
  room.night = { mafiaVotes: {}, doctorVotes: {}, detectiveVotes: {} };
  room.lastNight = null;
  narrate(room, `Night ${room.round} falls. The town is asleep.`);
  pushState(room);
}

// Resolves a team's night votes down to one target: most-voted wins,
// ties broken at random. Used identically for the mafia kill and the
// detective investigation — both are one shared decision per team, per night.
function majorityPick(votes) {
  const tally = {};
  for (const t of Object.values(votes)) tally[t] = (tally[t] || 0) + 1;
  const top = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  if (!top.length) return null;
  const best = top[0][1];
  const tied = top.filter(([, c]) => c === best).map(([id]) => id);
  return tied[Math.floor(Math.random() * tied.length)];
}

function resolveNight(room) {
  const n = room.night;

  const killId = majorityPick(n.mafiaVotes);
  // the doctors' one shared save — same majority + random tiebreak as the
  // kill, so two doctors disagreeing no longer means "whoever clicked last"
  const saveId = majorityPick(n.doctorVotes);
  const saved = !!(killId && saveId && killId === saveId);
  let diedName = null;
  if (killId && !saved) {
    const victim = room.players[killId];
    if (victim && victim.alive) {
      victim.alive = false;
      diedName = victim.name;
    }
  }

  room.lastNight = {
    round: room.round,
    diedName,
    saved,
    savedName: saved ? room.players[saveId]?.name : null,
  };

  // detective investigation = the team's one shared target for the night,
  // revealed to every living detective at once (mirrors the mafia kill).
  const investigateId = majorityPick(n.detectiveVotes);
  if (investigateId) {
    const target = room.players[investigateId];
    if (target) {
      const result = { name: target.name, isMafia: target.role === ROLE.MAFIA };
      for (const p of alivePlayers(room)) {
        if (p.role === ROLE.DETECTIVE) io.to(p.id).emit('detectiveResult', result);
      }
    }
  }

  if (diedName) narrate(room, `Dawn breaks. ${diedName} did not survive the night.`);
  else if (saved) narrate(room, `Dawn breaks. The mafia struck, but the doctor saved the target — no one died.`);
  else narrate(room, `Dawn breaks. Everyone survived the night.`);

  if (checkWin(room)) return;
  startDay(room);
}

function startDay(room) {
  room.phase = 'day';
  narrate(room, `Day ${room.round}: discuss and vote on WhatsApp. The host will enter the result.`);
  pushState(room);
}

function dayEliminate(room, targetId) {
  if (targetId) {
    const p = room.players[targetId];
    if (p && p.alive) {
      p.alive = false;
      narrate(room, `The town voted. ${p.name} was eliminated — they were ${p.role.toUpperCase()}.`);
    }
  } else {
    narrate(room, `The town could not agree. No one was eliminated.`);
  }
  if (checkWin(room)) return;
  startNight(room);
}

function checkWin(room) {
  const mafiaAlive = aliveOf(room, ROLE.MAFIA).length;
  const townAlive = alivePlayers(room).length - mafiaAlive;
  if (mafiaAlive === 0) {
    room.winner = 'town';
    room.phase = 'over';
    narrate(room, `The last mafia is gone. TOWN WINS.`);
    pushState(room);
    return true;
  }
  if (mafiaAlive >= townAlive) {
    room.winner = 'mafia';
    room.phase = 'over';
    narrate(room, `The mafia now equal or outnumber the town. MAFIA WINS.`);
    pushState(room);
    return true;
  }
  return false;
}

/* --------------------------- socket wiring ------------------------ */
io.on('connection', (socket) => {
  socket.data.roomCode = null;

  socket.on('createRoom', ({ config }, cb) => {
    const clean = {
      mafia: Math.max(1, Math.min(10, parseInt(config?.mafia) || 1)),
      doctor: Math.max(0, Math.min(10, parseInt(config?.doctor) || 0)),
      detective: Math.max(0, Math.min(10, parseInt(config?.detective) || 0)),
    };
    const code = makeCode();
    rooms[code] = {
      code,
      hostId: socket.id,
      hostToken: crypto.randomUUID(), // lets the host's browser reclaim this room after a reconnect
      phase: 'lobby',
      round: 0,
      config: clean,
      players: {},
      order: [],
      night: null,
      lastNight: null,
      narration: [{ t: Date.now(), text: 'Room created. Waiting for players to join.' }],
      winner: null,
    };
    socket.data.roomCode = code;
    socket.join(code);
    cb && cb({ ok: true, code, hostToken: rooms[code].hostToken });
    pushState(rooms[code]);
  });

  socket.on('joinRoom', ({ code, name, phone }, cb) => {
    code = (code || '').toUpperCase().trim();
    const room = rooms[code];
    if (!room) return cb && cb({ ok: false, error: 'No room with that code.' });
    if (room.phase !== 'lobby') return cb && cb({ ok: false, error: 'That game has already started.' });
    name = (name || '').trim().slice(0, 20) || 'Player';
    room.players[socket.id] = {
      id: socket.id,
      token: crypto.randomUUID(), // lets this player's browser reclaim their seat after a reconnect
      name,
      phone: normalizePhone(phone),
      role: null,
      alive: true,
      connected: true,
      isHost: false,
    };
    room.order.push(socket.id);
    socket.data.roomCode = code;
    socket.join(code);
    narrate(room, `${name} joined.`);
    cb && cb({ ok: true, code, token: room.players[socket.id].token });
    pushState(room);
  });

  // Reclaims a seat after a reconnect — a dropped connection, a page
  // refresh, or the server itself having restarted. The old socket id
  // is dead either way; the token is what proves who this browser is.
  socket.on('rejoinRoom', ({ code, token, isHost }, cb) => {
    code = (code || '').toUpperCase().trim();
    const room = rooms[code];
    if (!room) return cb && cb({ ok: false, error: 'Room no longer exists.' });

    if (isHost) {
      if (!token || token !== room.hostToken) return cb && cb({ ok: false, error: 'Invalid host session.' });
      room.hostId = socket.id;
      socket.data.roomCode = code;
      socket.join(code);
      cb && cb({ ok: true, code });
      pushState(room);
      return;
    }

    const oldId = Object.keys(room.players).find((id) => room.players[id].token === token);
    if (!oldId) return cb && cb({ ok: false, error: 'Could not find your seat in this room.' });

    const player = room.players[oldId];
    delete room.players[oldId];
    player.id = socket.id;
    player.connected = true;
    room.players[socket.id] = player;
    room.order = room.order.map((id) => (id === oldId ? socket.id : id));
    if (room.hostId === oldId) room.hostId = socket.id;

    socket.data.roomCode = code;
    socket.join(code);
    cb && cb({ ok: true, code });

    if (player.role) {
      io.to(socket.id).emit('youAre', { role: player.role, teammates: teammatesOf(room, player) });
    }
    pushState(room);
  });

  socket.on('startGame', () => {
    const room = rooms[socket.data.roomCode];
    if (!room || socket.id !== room.hostId || room.phase !== 'lobby') return;
    const total = room.order.length;
    const need = room.config.mafia + room.config.doctor + room.config.detective;
    if (total < 4) return io.to(socket.id).emit('toast', 'Need at least 4 players.');
    if (need > total) return io.to(socket.id).emit('toast', 'More special roles than players.');
    assignRoles(room);
    narrate(room, `Roles dealt to ${total} players.`);
    startNight(room);
  });

  socket.on('nightAction', ({ type, targetId }) => {
    const room = rooms[socket.data.roomCode];
    if (!room || room.phase !== 'night') return;
    const me = room.players[socket.id];
    if (!me || !me.alive || me.role !== type) return;
    const target = room.players[targetId];
    if (!target || !target.alive) return;

    if (type === ROLE.MAFIA) {
      room.night.mafiaVotes[me.id] = targetId;
    } else if (type === ROLE.DOCTOR) {
      room.night.doctorVotes[me.id] = targetId;
    } else if (type === ROLE.DETECTIVE) {
      // vote toward the team's one shared investigation target — same
      // majority + random-tiebreak resolution as the mafia kill, resolved
      // (and revealed to the whole detective team) at dawn.
      room.night.detectiveVotes[me.id] = targetId;
    }
    pushState(room);
  });

  socket.on('resolveNight', () => {
    const room = rooms[socket.data.roomCode];
    if (!room || socket.id !== room.hostId || room.phase !== 'night') return;
    resolveNight(room);
  });

  socket.on('dayEliminate', ({ targetId }) => {
    const room = rooms[socket.data.roomCode];
    if (!room || socket.id !== room.hostId || room.phase !== 'day') return;
    dayEliminate(room, targetId || null);
  });

  socket.on('resetGame', () => {
    const room = rooms[socket.data.roomCode];
    if (!room || socket.id !== room.hostId) return;
    for (const p of playersArr(room)) {
      p.role = null;
      p.alive = true;
    }
    room.phase = 'lobby';
    room.round = 0;
    room.night = null;
    room.lastNight = null;
    room.winner = null;
    room.narration = [{ t: Date.now(), text: 'New game. Waiting in the lobby.' }];
    pushState(room);
  });

  // Same players, freshly shuffled roles — skips the lobby entirely if the
  // room still has enough players for the current role config.
  socket.on('newGame', () => {
    const room = rooms[socket.data.roomCode];
    if (!room || socket.id !== room.hostId) return;
    for (const p of playersArr(room)) {
      p.role = null;
      p.alive = true;
    }
    room.phase = 'lobby';
    room.round = 0;
    room.night = null;
    room.lastNight = null;
    room.winner = null;

    const total = room.order.length;
    const need = room.config.mafia + room.config.doctor + room.config.detective;
    if (total < 4 || need > total) {
      room.narration = [{ t: Date.now(), text: 'New game. Waiting in the lobby.' }];
      pushState(room);
      return;
    }
    room.narration = [{ t: Date.now(), text: 'New game — roles reshuffled.' }];
    assignRoles(room);
    narrate(room, `Roles dealt to ${total} players.`);
    startNight(room);
  });

  // A deliberate "Leave game" — distinct from an accidental drop. Only an
  // intentional leave (or a host removal) releases the seat; a network blip
  // always holds it. In-game leavers keep their seat so the role balance and
  // win condition stay intact; they simply stop rejoining.
  socket.on('leaveRoom', (_payload, cb) => {
    const room = rooms[socket.data.roomCode];
    if (!room) return cb && cb({ ok: true });
    const p = room.players[socket.id];
    if (p && room.phase === 'lobby') {
      delete room.players[socket.id];
      room.order = room.order.filter((id) => id !== socket.id);
      narrate(room, `${p.name} left the lobby.`);
    } else if (p) {
      p.connected = false;
      narrate(room, `${p.name} left the game.`);
    }
    socket.leave(room.code);
    socket.data.roomCode = null;
    cb && cb({ ok: true });
    if (rooms[room.code]) pushState(room);
  });

  // Host clears out a no-show before dealing roles. Lobby-only: once roles
  // are dealt, removing someone would corrupt the role balance mid-game.
  socket.on('removePlayer', ({ targetId }) => {
    const room = rooms[socket.data.roomCode];
    if (!room || socket.id !== room.hostId || room.phase !== 'lobby') return;
    const p = room.players[targetId];
    if (!p) return;
    delete room.players[targetId];
    room.order = room.order.filter((id) => id !== targetId);
    io.to(targetId).emit('removed');
    narrate(room, `${p.name} was removed from the lobby by the host.`);
    pushState(room);
  });

  // The host explicitly closing the room, instead of waiting on a timeout.
  socket.on('endGame', () => {
    const room = rooms[socket.data.roomCode];
    if (!room || socket.id !== room.hostId) return;
    io.to(room.code).emit('gameEnded');
    delete rooms[room.code];
    saveRooms();
  });

  socket.on('disconnect', () => {
    const room = rooms[socket.data.roomCode];
    if (!room) return;
    if (socket.id === room.hostId) {
      // Don't close the room just because the host's connection dropped — a
      // wifi blip or a server restart looks identical to this from here, and
      // rejoinRoom lets them reclaim it. The room now only goes away when the
      // host explicitly ends it (see 'endGame' above).
      narrate(room, 'The host disconnected. Waiting for them to reconnect...');
      io.to(room.code).emit('toast', 'Host disconnected — waiting for them to reconnect.');
      pushState(room);
      return;
    }
    const p = room.players[socket.id];
    if (p) {
      // Never drop the seat on disconnect — phones blip constantly while a
      // big group trickles into the lobby, and deleting the seat destroys the
      // token that rejoinRoom needs, ejecting them permanently. The host
      // removes genuine no-shows explicitly via 'removePlayer'.
      p.connected = false;
      narrate(room, `${p.name} lost connection (seat held).`);
      pushState(room);
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Mafia God server running on http://localhost:${PORT}`);
});

// flush state to disk before pm2/systemd tears the process down
function shutdown() {
  saveRooms();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
