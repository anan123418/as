/*
  Haxball Headless Bot — Voting, AFK, Anti-Multi — v5.3 (FINAL PRO) + AUTH/ADMIN AFK
  - v5.1 kalıcı storage ENTEGRE (Node: roles.json, Browser: localStorage)
  - v5.0 tüm özellikler KORUNDU
  - v5.2: !afk eklendi (kullanıcı)
  - v5.3: Anti-Multi PRO (aynı isim engeli, re-join kilidi, blacklist, multilogin toggles)
  - + Bu build: admin "!afk <id>" ile hedefi AFK yapabilir/KALDIRABİLİR (toggle)
  - + Bu build: admin "!auth <id>" ile AUTH/CONN'ı tam görebilir
  - + Bu build: !dava duyurusunda hedefin AUTH (tam) + CONN (maskeli) gösterilir
  - + Bu build: spam/jail ilanlarında kimlik etiketi (AUTH/CONN maskeli)
  - + Bu build: !spamkuralkaldir / !spamkuralac ile anti-spam kuralları aç/kapa (global)
  - + Kalıcı roller AUTH yoksa CONN anahtarıyla da otomatik eşleşir (mevcut logic)
*/

//////////////////////////////
// Kalıcı Storage (v5.1)
//////////////////////////////
const fs = (typeof require !== 'undefined') ? require('fs') : null;
const STORAGE_FILE = 'roles.json';

function storageLoad(){
  try{
    if(fs && fs.existsSync(STORAGE_FILE)){
      const txt = fs.readFileSync(STORAGE_FILE,'utf8');
      return new Map(JSON.parse(txt));
    } else if(typeof localStorage!=='undefined'){
      const txt = localStorage.getItem('roles');
      return txt ? new Map(JSON.parse(txt)) : new Map();
    }
  }catch(e){ console.log('storageLoad error', e); }
  return new Map();
}
function storageSave(map){
  try{
    const arr = [...map.entries()];
    if(fs){
      fs.writeFileSync(STORAGE_FILE, JSON.stringify(arr));
    } else if(typeof localStorage!=='undefined'){
      localStorage.setItem('roles', JSON.stringify(arr));
    }
  }catch(e){ console.log('storageSave error', e); }
}

//////////////////////////////
// Oda
//////////////////////////////
const room = HBInit({
  roomName: "Sohbet Muhabbet Odası",
  maxPlayers: 12,
  public: true,
  noPlayer: false,
  token:"thr1.AAAAAGilBsAAuGye9nw_dQ.Fj6xIFbUmn4"
});

//////////////////////////////
// Ayarlar
//////////////////////////////
const ADMIN_PASSWORD          = "DEGISTIRIN-guclu-bir-sifre"; // <- değiştir
const AUTO_START_DELAY_MS     = 10_000;   // 10 sn
const JAIL_DURATION_MS        = 5 * 60_000; // 5 dk
const VOTE_DURATION_MS        = 3 * 60_000; // 3 dk
const AFK_TIMEOUT_MS          = 90_000;   // 1.5 dk
const AFK_CHECK_INTERVAL      = 5_000;    // 5 sn
const VOTE_THRESHOLD          = 0.60;     // %60 anında karar
const VOTE_FEED_PUBLIC_DEF    = true;

// Af savunma penceresi (spamcıya)
const AF_DEFENSE_TOTAL_MS     = 10_000;
const AF_DEFENSE_BURST_MS     = 5_000;

// Relay
const RELAY_PREFIX_DEF        = "";

// Anti-Multi varsayılanları
const ANTI_MULTI_BY_AUTH_DEFAULT = true;
const ANTI_MULTI_BY_CONN_DEFAULT = true;
let   MULTI_ALLOW_MULTI_LOGIN     = false;      // .multilogin (sekme/ikinci oturum serbest mi)
let   MULTI_REJOIN_WINDOW_MS      = 30_000;     // hızlı re-join kilidi (0 = kapalı)
const NAME_DUPLICATE_BLOCK        = true;       // aynı isim anında kick

// Anti-Spam
let SPAM_TRIGGER_MS           = 1200;
let SPAM_WARNINGS_BEFORE_ROLE = 3;
let SPAM_INITIAL_COOLDOWN_MS  = 19_000;
const SPAM_ESCALATION_MS      = 5_000;
const SPAM_MAX_COOLDOWN_MS    = 120_000;
const SPAM_PM_EVERY_N_BLOCKS  = 3;
let SPAM_RULES_ENABLED        = true;     // <<< yeni: global anti-spam aç/kapa

//////////////////////////////
// Durum
//////////////////////////////
let gameStartTimeout = null;
const playerData = Object.create(null);
let antiMultiByAuthEnabled = ANTI_MULTI_BY_AUTH_DEFAULT;
let antiMultiByConnEnabled = ANTI_MULTI_BY_CONN_DEFAULT;
let voteFeedPublic = VOTE_FEED_PUBLIC_DEF;
let RELAY_PREFIX = RELAY_PREFIX_DEF;

// v5.1 storage destekli kalıcı roller
const persistent = storageLoad();

// v5.3 Anti-Multi yardımcı kayıtlar
const lastSeenByAuth = new Map();  // auth -> ts (leave zamanı)
const lastSeenByConn = new Map();  // conn -> ts
const blacklist = {
  name:     new Set(),      // tam ad
  namepart: new Set(),      // ad içinde geçen parça (lowercase)
  auth:     new Set(),
  conn:     new Set(),
};

//////////////////////////////
// Helpers
//////////////////////////////
const now = () => Date.now();
const isHost = (p) => p && p.id === 0;
const getPlayer = (id) => room.getPlayerList().find(p => p.id === id) || null;
const pdataOf = (id) => playerData[id];
const isAFK = (id) => !!(pdataOf(id) && pdataOf(id).isAFK === true);
const isJailed = (id) => !!(pdataOf(id) && pdataOf(id).jailedUntil > now());

function safe(fn){ try{ fn(); }catch(_){} }
function safeSendChat(msg, id){ safe(() => room.sendChat(msg, id)); }
function sendPrivate(id, msg){ safeSendChat(`[ÖZEL] ${msg}`, id); }
function system(msg){ safeSendChat(`${msg}`, null); }

function normalize(str){
  return (str||"")
    .replace(/[\u200B\u200C\u200D\u200E\u200F\uFEFF\u00A0]/g, "")
    .trim();
}
function normalizeCmdWord(w){
  return w.toLowerCase()
    .replace(/ı/g,'i').replace(/İ/g,'i')
    .replace(/ş/g,'s').replace(/Ş/g,'s')
    .replace(/ğ/g,'g').replace(/Ğ/g,'g')
    .replace(/ç/g,'c').replace(/Ç/g,'c')
    .replace(/ö/g,'o').replace(/Ö/g,'o')
    .replace(/ü/g,'u').replace(/Ü/g,'u');
}

// Kimlik yardımcıları (AUTH/CONN)
function keysForPlayer(p){
  const keys = [];
  if(!p) return keys;
  if(p.auth) keys.push(p.auth);
  if(p.conn) keys.push(`CONN:${p.conn}`);
  return keys;
}
function maskAuth(s, showStart=6, showEnd=4){
  if(!s) return '(yok)';
  if(s.length <= showStart+showEnd) return s;
  return s.slice(0,showStart)+'…'+s.slice(-showEnd);
}
function maskConn(c){
  if(!c) return '(yok)';
  const v4 = c.match(/^(\d+\.\d+\.\d+)\.(\d+)$/);
  if(v4) return v4[1]+'.*';
  if(c.length>10) return c.slice(0,6)+'…'+c.slice(-2);
  return c;
}
function getAuthConnTag(p, masked=true){
  const a = p?.auth || '(yok)';
  const c = p?.conn || '(yok)';
  return masked ? `AUTH:${maskAuth(a)} • CONN:${maskConn(c)}` : `AUTH:${a} • CONN:${c}`;
}

function loadPersistentInto(id){
  const p = getPlayer(id); if(!p) return;
  const pd = pdataOf(id);  if(!pd) return;
  for(const key of keysForPlayer(p)){
    if(!persistent.has(key)) continue;
    const saved = persistent.get(key);
    if(saved.isSpammer) pd.isSpammer = true;
    if(saved.spamCooldownMs) pd.spamCooldownMs = Math.max(saved.spamCooldownMs, SPAM_INITIAL_COOLDOWN_MS);
    if(Number.isFinite(saved.spamWarnings)) pd.spamWarnings = saved.spamWarnings;
    if(saved.jailedUntil && saved.jailedUntil > now()) pd.jailedUntil = saved.jailedUntil;
    break;
  }
}
function savePersistentFrom(id){
  const p = getPlayer(id); if(!p) return;
  const pd = pdataOf(id);  if(!pd) return;
  const obj = {
    isSpammer: !!pd.isSpammer,
    spamCooldownMs: pd.spamCooldownMs || SPAM_INITIAL_COOLDOWN_MS,
    spamWarnings: pd.spamWarnings || 0,
    jailedUntil: pd.jailedUntil || 0,
  };
  for(const key of keysForPlayer(p)) persistent.set(key, obj);
  storageSave(persistent);
}

function pmTag(id, msg){
  const p = getPlayer(id);
  const tag = p ? `@${p.name}` : "@oyuncu";
  sendPrivate(id, `${tag} ${msg}`);
}

function isEligibleVoter(id, targetId){
  const p = getPlayer(id);
  if(!p) return false;
  if(isHost(p)) return false;
  if(id === targetId) return false;
  if(isJailed(id)) return false;
  if(isAFK(id)) return false;
  if(pdataOf(id)?.isSpammer) return false;
  return true;
}
function eligibleVotersList(targetId){ return room.getPlayerList().filter(p => isEligibleVoter(p.id, targetId)); }
function requiredVotesCount(targetId){ const n=eligibleVotersList(targetId).length; return Math.max(1, Math.ceil(n*VOTE_THRESHOLD)); }
function anyActiveVote(){ for (const pid in playerData) if (playerData[pid]?.ongoingVote) return true; return false; }
function findActiveVoteEntry(){ for (const pid in playerData){ const v=playerData[pid]?.ongoingVote; if(v) return {targetId:Number(pid), vote:v}; } return null; }
function recomputeTallies(targetId){
  const pd = pdataOf(targetId); if(!pd||!pd.ongoingVote) return;
  let e=0,h=0;
  for (const [uid,val] of pd.ongoingVote.votes.entries()){
    const id = Number(uid);
    if(!isEligibleVoter(id,targetId)) continue;
    if(val==='evet') e++; else if(val==='hayir') h++;
  }
  pd.ongoingVote.evetSayisi=e; pd.ongoingVote.hayirSayisi=h;
}
function finishVoteSuccess(targetId){
  const pd=pdataOf(targetId); if(!pd||!pd.ongoingVote) return;
  const v=pd.ongoingVote; const tp=getPlayer(targetId); const tname=tp?tp.name:`ID:${targetId}`;
  if((v.kind||'trial')==='pardon'){
    pd.isSpammer=false; pd.spamWarnings=0; pd.spamCooldownMs=SPAM_INITIAL_COOLDOWN_MS; pd.spamBlockCount=0; pd.defenseFreeUntil=0;
    savePersistentFrom(targetId);
    const tag = tp?` • ${getAuthConnTag(tp,true)}`:'';
    system(`✅ Af oylaması: ${tname} (${targetId}) üzerindeki spamcı rolü kaldırıldı.${tag}`);
    pmTag(targetId, "af oylaman KABUL edildi. Spam kısıtların sıfırlandı.");
  } else {
    pd.jailedUntil = now()+JAIL_DURATION_MS;
    savePersistentFrom(targetId);
    const tag = tp?` • ${getAuthConnTag(tp,true)}`:'';
    system(`⚖️ Karar: ${tname} (${targetId}) ${Math.floor(JAIL_DURATION_MS/60000)} dk jail’e atıldı.${tag}`);
    pmTag(targetId, `${Math.floor(JAIL_DURATION_MS/60000)} dk jaildesin. !ceza ile bak.`);
  }
  clearTimeout(v.timer); pd.ongoingVote=null;
}
function finishVoteReject(targetId){
  const pd=pdataOf(targetId); if(!pd||!pd.ongoingVote) return;
  const v=pd.ongoingVote; const tp=getPlayer(targetId); const tname=tp?tp.name:`ID:${targetId}`;
  if((v.kind||'trial')==='pardon'){ system(`❌ Af RED: ${tname} (${targetId}) için spamcı rolü devam.`); pmTag(targetId, "af oylaman REDDEDİLDİ."); }
  else { system(`❌ Dava RED: ${tname} (${targetId}) serbest.`); pmTag(targetId, "dava aleyhine sonuçlanmadı."); }
  clearTimeout(v.timer); pd.ongoingVote=null;
}
function evaluateVote(targetId){
  const pd=pdataOf(targetId); if(!pd||!pd.ongoingVote) return;
  recomputeTallies(targetId);
  const need=requiredVotesCount(targetId);
  if(pd.ongoingVote.evetSayisi>=need) finishVoteSuccess(targetId);
}
function scheduleVoteTimeout(targetId){
  const pd=pdataOf(targetId); if(!pd||!pd.ongoingVote) return;
  const v=pd.ongoingVote; if(v.timer) clearTimeout(v.timer);
  v.timer=setTimeout(()=>{
    recomputeTallies(targetId);
    const vv=pdataOf(targetId)?.ongoingVote; if(!vv) return;
    if(vv.evetSayisi>vv.hayirSayisi) finishVoteSuccess(targetId); else finishVoteReject(targetId);
  }, v.durationMs);
}

//////////////////////////////
// Görünüm & Relay
//////////////////////////////
function displayNameById(id){
  const p=getPlayer(id); if(!p) return `ID:${id}`;
  const pd=pdataOf(id)||{};
  const tags=[]; if(pd.isSpammer) tags.push('spamci'); if(isJailed(id)) tags.push('jail'); if(pd.isAFK) tags.push('afk');
  const badge=tags.length?`[${tags.join('|')}]`:'';
  return `${p.name}(ID:${id})${badge}`;
}
function formatGeneral(senderId, text){ return `${RELAY_PREFIX}${displayNameById(senderId)}: ${text}`; }
function relayGeneralMessage(senderId, text){
  const out=formatGeneral(senderId,text);
  room.getPlayerList().forEach(p=>{ if(isHost(p)) return; if(!isJailed(p.id)) safeSendChat(out,p.id); });
}
function relayJailMessage(senderId, text, label){
  const tag=label||'[JAIL]'; const out=`${tag} ${displayNameById(senderId)}: ${text}`;
  room.getPlayerList().forEach(p=>{
    const pd=pdataOf(p.id); if(!pd) return;
    const watch=pd.isAdmin&&pd.seesJailChat===true;
    if(isJailed(p.id)||watch) safeSendChat(out,p.id);
  });
}

//////////////////////////////
// Takım & Autostart
//////////////////////////////
function autoAssignTeams(){
  const players=room.getPlayerList().filter(p=>p.id!==0);
  let red=players.filter(p=>p.team===1), blue=players.filter(p=>p.team===2);
  for(const p of players){
    if(p.team===0 && !isAFK(p.id)){
      safe(()=>{ if(red.length<=blue.length){ room.setPlayerTeam(p.id,1); red.push(p); }
                 else { room.setPlayerTeam(p.id,2); blue.push(p); } });
    }
  }
}
function safeStartGame(){ safe(()=>room.startGame()); }
function safeStopGame(){ safe(()=>room.stopGame()); }
function startGameTimerIfNeeded(){
  const players=room.getPlayerList().filter(p=>p.id!==0);
  const red=players.filter(p=>p.team===1), blue=players.filter(p=>p.team===2);
  const running=room.getScores()!==null;
  if(red.length>0 && blue.length>0 && !running){
    if(gameStartTimeout) clearTimeout(gameStartTimeout);
    gameStartTimeout=setTimeout(()=>{
      const pl=room.getPlayerList().filter(p=>p.id!==0);
      const r=pl.filter(p=>p.team===1), b=pl.filter(p=>p.team===2);
      if(r.length>0 && b.length>0 && room.getScores()===null) safeStartGame();
      gameStartTimeout=null;
    }, AUTO_START_DELAY_MS);
  } else { if(gameStartTimeout){ clearTimeout(gameStartTimeout); gameStartTimeout=null; } }
}
function autoAssignTeamsAndMaybeStart(){ autoAssignTeams(); startGameTimerIfNeeded(); }

// AFK'dan dönüşte takıma yerleştirme (denge)
function putBackBalanced(id){
  const list=room.getPlayerList().filter(p=>!isHost(p));
  const rc=list.filter(p=>p.team===1).length, bc=list.filter(p=>p.team===2).length;
  safe(()=>{ if(rc===bc) room.setPlayerTeam(id, Math.random()<0.5?1:2);
             else room.setPlayerTeam(id, rc<bc?1:2); });
}

//////////////////////////////
// AFK
//////////////////////////////
function markActive(id){
  const pd=pdataOf(id); if(!pd) return;
  pd.lastActive=now(); if(pd.isAFK) pd.isAFK=false;
  const a=findActiveVoteEntry(); if(a) evaluateVote(a.targetId);
}
setInterval(()=>{
  for(const p of room.getPlayerList()){
    if(isHost(p)) continue;
    const pd=pdataOf(p.id); if(!pd) continue;
    const inactive=!pd.lastActive || (now()-pd.lastActive>AFK_TIMEOUT_MS);
    if(inactive && !pd.isAFK){
      pd.isAFK=true; if(p.team!==0) safe(()=>room.setPlayerTeam(p.id,0));
      pmTag(p.id,'AFK oldun ve Seyirciye alındın. Oyuna dönmek için !gir.');
      const a=findActiveVoteEntry(); if(a) evaluateVote(a.targetId);
    }
  }
}, AFK_CHECK_INTERVAL);

//////////////////////////////
// Anti-Multi PRO
//////////////////////////////
function hasExactNameDuplicate(newPlayer){
  if(!NAME_DUPLICATE_BLOCK) return false;
  const nameLC=(newPlayer.name||"").toLocaleLowerCase();
  return room.getPlayerList().some(p => p.id!==newPlayer.id && (p.name||"").toLocaleLowerCase()===nameLC);
}
function matchesBlacklist(p){
  const n = (p.name||"");
  const nlc = n.toLocaleLowerCase();
  if(blacklist.name.has(n)) return {type:'name',value:n};
  for(const part of blacklist.namepart){ if(part && nlc.includes(part)) return {type:'namepart',value:part}; }
  if(p.auth && blacklist.auth.has(p.auth)) return {type:'auth',value:p.auth};
  if(p.conn && blacklist.conn.has(p.conn)) return {type:'conn',value:p.conn};
  return null;
}
function duplicatesAgainst(list, newcomer){
  for(const q of list){
    if(q.id===newcomer.id || isHost(q)) continue;
    if(antiMultiByAuthEnabled && newcomer.auth && q.auth && newcomer.auth===q.auth) return true;
    if(antiMultiByConnEnabled && newcomer.conn && q.conn && newcomer.conn===q.conn) return true;
  }
  return false;
}
function violatesRejoinWindow(newPlayer){
  if(!MULTI_REJOIN_WINDOW_MS) return false;
  const t=now();
  if(newPlayer.auth && lastSeenByAuth.has(newPlayer.auth)){
    if(t - lastSeenByAuth.get(newPlayer.auth) < MULTI_REJOIN_WINDOW_MS) return 'auth';
  }
  if(newPlayer.conn && lastSeenByConn.has(newPlayer.conn)){
    if(t - lastSeenByConn.get(newPlayer.conn) < MULTI_REJOIN_WINDOW_MS) return 'conn';
  }
  return false;
}
// Ana kapı
function enforceAntiMultiOnJoin(newPlayer){
  // 0) blacklist
  const bl = matchesBlacklist(newPlayer);
  if(bl){
    safe(()=>room.kickPlayer(newPlayer.id, `blacklist (${bl.type})`, true));
    return true;
  }
  // 1) aynı isim
  if(hasExactNameDuplicate(newPlayer)){
    safe(()=>room.kickPlayer(newPlayer.id, 'Odada aynı adlı bir oyuncu var.', false));
    return true;
  }
  // 2) aynı anda multi (sekme / farklı nick)
  if(!(MULTI_ALLOW_MULTI_LOGIN)){
    const list=room.getPlayerList();
    if(duplicatesAgainst(list, newPlayer)){
      safe(()=>room.kickPlayer(newPlayer.id, 'Çoklu giriş: aktif başka oturumun var.', false));
      return true;
    }
  }
  // 3) hızlı re-join kilidi
  const vio = violatesRejoinWindow(newPlayer);
  if(vio){
    safe(()=>room.kickPlayer(newPlayer.id, `Hızlı tekrar giriş engeli (${vio}). Biraz bekleyip gel.`, false));
    return true;
  }
  return false;
}
function recordLastSeen(player){
  if(player.auth) lastSeenByAuth.set(player.auth, now());
  if(player.conn) lastSeenByConn.set(player.conn, now());
}

//////////////////////////////
// Eventler
//////////////////////////////
room.onPlayerJoin = function(player){
  if(enforceAntiMultiOnJoin(player)) return;
  setTimeout(()=>{ if(getPlayer(player.id)) enforceAntiMultiOnJoin(player); }, 700);

  playerData[player.id] = {
    isAdmin:false, mutedByAdmin:false, jailedUntil:0, ongoingVote:null,
    seesJailChat:false, lastActive:now(), isAFK:false,
    lastChatAt:0, lastAllowedAt:0, spamWarnings:0, isSpammer:false,
    spamCooldownMs:SPAM_INITIAL_COOLDOWN_MS, spamBlockCount:0,
    defenseFreeUntil:0,
  };

  loadPersistentInto(player.id);

  if(!isHost(player)){
    system(`➡️ Katıldı: ${player.name} (ID:${player.id}). Yardım: !help`);
    const pd=pdataOf(player.id);
    if(pd.isSpammer){
      pmTag(player.id, `spamcı rolündesin. Mesaj aralığı ${(pd.spamCooldownMs/1000)|0} sn. Af: !aftalep <gerekçe> (10 sn savunma).`);
    }
    if(isJailed(player.id)){
      const rem=pdataOf(player.id).jailedUntil-now();
      const m=Math.max(0,Math.floor(rem/60000)), s=Math.max(0,Math.floor((rem%60000)/1000));
      pmTag(player.id, `jail cezan sürüyor. Kalan: ${m} dk ${s} sn. Bilgi: !ceza`);
    }
    if(!pd.isSpammer && !isJailed(player.id)){
      pmTag(player.id, "Komut: !dava <id> <sebep> • !evet/!hayır • !afk • !gir • !help");
    }
  }
  autoAssignTeamsAndMaybeStart();
};

room.onPlayerLeave = function(player){
  if(playerData[player.id]) savePersistentFrom(player.id);
  recordLastSeen(player);

  for(const pid in playerData){
    const pd=playerData[pid]; if(!pd?.ongoingVote) continue;
    pd.ongoingVote.votes.delete(player.id);
    recomputeTallies(Number(pid));
  }
  delete playerData[player.id];

  if(!isHost(player)) system(`⬅️ Ayrıldı: ${player.name}.`);
  autoAssignTeamsAndMaybeStart();
};

room.onTeamVictory = function(){
  system('🏁 Oyun bitti. 3 sn sonra yeni oyun...');
  setTimeout(()=>{
    safeStopGame(); autoAssignTeams();
    const players=room.getPlayerList().filter(p=>p.id!==0);
    const red=players.filter(p=>p.team===1), blue=players.filter(p=>p.team===2);
    if(red.length>0 && blue.length>0) safeStartGame(); else startGameTimerIfNeeded();
  }, 3000);
};
room.onPlayerKicked = function(){ const a=findActiveVoteEntry(); if(a) evaluateVote(a.targetId); };
room.onPlayerActivity = function(player){ if(isHost(player)) return false; markActive(player.id); };
room.onGameStart = function(){
  room.getPlayerList().forEach(p=>{ if(isHost(p)) return; if(isAFK(p.id) && p.team!==0) safe(()=>room.setPlayerTeam(p.id,0)); });
};

//////////////////////////////
// Chat & Komutlar
//////////////////////////////
room.onPlayerChat = function(player, message){
  if(isHost(player)) return false;
  const pd=pdataOf(player.id); if(!pd) return false;
  if(pd.mutedByAdmin) return false;

  markActive(player.id);
  const cleaned=normalize(message);

  // Ceza bitiş
  if(pd.jailedUntil && pd.jailedUntil <= now()){
    pd.jailedUntil=0; savePersistentFrom(player.id); pmTag(player.id,'cezan sona erdi.');
  }

  // Anti-Spam (komut değilse)
  if(!cleaned.startsWith('!')){
    if(!SPAM_RULES_ENABLED){
      if(isJailed(player.id)) relayJailMessage(player.id,message); else relayGeneralMessage(player.id,message);
      return false;
    }
    const t=now();
    if(pd.isSpammer && pd.defenseFreeUntil && t < pd.defenseFreeUntil){
      pd.lastAllowedAt=t; pd.spamBlockCount=0;
      if(isJailed(player.id)) relayJailMessage(player.id,message); else relayGeneralMessage(player.id,message);
      return false;
    }
    if(pd.isSpammer){
      const since = t - (pd.lastAllowedAt||0);
      if(since < pd.spamCooldownMs){
        pd.spamCooldownMs = Math.min(SPAM_MAX_COOLDOWN_MS, pd.spamCooldownMs + SPAM_ESCALATION_MS);
        pd.spamBlockCount = (pd.spamBlockCount||0) + 1;
        if(pd.spamBlockCount % SPAM_PM_EVERY_N_BLOCKS === 0){
          const remain = Math.ceil((pd.spamCooldownMs - since)/1000);
          pmTag(player.id, `spam engellendi. Yeni aralık ${(pd.spamCooldownMs/1000)|0} sn. Kalan ~${remain} sn.`);
        }
        savePersistentFrom(player.id);
        return false;
      }
      pd.lastAllowedAt=t; pd.spamBlockCount=0;
    } else {
      const diff=t-(pd.lastChatAt||0);
      if(diff < SPAM_TRIGGER_MS){
        pd.spamWarnings=(pd.spamWarnings||0)+1;
        if(pd.spamWarnings >= SPAM_WARNINGS_BEFORE_ROLE){
          pd.isSpammer=true; pd.spamCooldownMs=SPAM_INITIAL_COOLDOWN_MS; pd.lastAllowedAt=t; pd.spamBlockCount=0;
          savePersistentFrom(player.id);
          const p = getPlayer(player.id); const tag = p?` • ${getAuthConnTag(p,true)}`:'';
          system(`🚫 Spamcı: ${displayNameById(player.id)}${tag}. Mesaj aralığı ${(pd.spamCooldownMs/1000)|0} sn.`);
          pmTag(player.id,'spamcı rolü verildi. Af için !aftalep <gerekçe>.');
        } else { pmTag(player.id, `uyarı ${pd.spamWarnings}/${SPAM_WARNINGS_BEFORE_ROLE}: Çok hızlı yazıyorsun.`); }
      }
      pd.lastChatAt=t;
    }
    if(isJailed(player.id)) relayJailMessage(player.id,message); else relayGeneralMessage(player.id,message);
    return false;
  }

  // KOMUTLAR
  const partsRaw=cleaned.split(/\s+/);
  const cmd=normalizeCmdWord(partsRaw[0]);
  const parts=[cmd, ...partsRaw.slice(1)];

  switch(cmd){

    case '!help':{
      sendPrivate(player.id, [
        'Komutlar:',
        '+ !help | !players | !afk [id] | !gir | !ceza | !status',
        '+ !dava <id> <sebep> | !evet | !hayir',
        '+ — Spam/Af —',
        '+ !aftalep <mesaj> (sadece spamcı) | !evetaf | !hayiraf',
        '+ — Admin —',
        '+ !admin <şifre> | !gor | !mesaj <yazı> | !auth <id>',
        '+ !sifre <şifre> | !sifreac | !mute <id> | !unmute <id> | !ban <id> | !unban',
        '+ !start | !jail <dk> <id>',
        '+ !multi on|off|status | !multiauth on|off | !multiconn on|off',
        '+ !multilogin on|off | !multiwindow <saniye>',
        '+ !blacklist <name|namepart|auth|conn> add <değer>|list|clear',
        '+ !votefeed on|off | !setspam <uyarıSay> <tetikMs> <cooldownMs>',
        '+ !spamkuralkaldir | !spamkuralac',
      ].join('\n'));
      break;
    }

    case '!status':{
      const pcount=room.getPlayerList().filter(p=>!isHost(p)).length;
      sendPrivate(player.id, [
        'Durum:',
        `- Oyuncu: ${pcount}`,
        `- Anti-Multi: AUTH ${antiMultiByAuthEnabled?'AÇIK':'KAPALI'} | CONN ${antiMultiByConnEnabled?'AÇIK':'KAPALI'}`,
        `- MultiLogin (sekme): ${MULTI_ALLOW_MULTI_LOGIN?'AÇIK':'KAPALI'}`,
        `- Re-join kilidi: ${MULTI_REJOIN_WINDOW_MS/1000|0} sn`,
        `- VoteFeed: ${voteFeedPublic?'AÇIK':'KAPALI'}`,
        `- Spam Kuralı: ${SPAM_RULES_ENABLED?'AÇIK':'KAPALI'}`,
        `- Spam: uyarı=${SPAM_WARNINGS_BEFORE_ROLE}, tetikMs=${SPAM_TRIGGER_MS}, cooldownMs=${SPAM_INITIAL_COOLDOWN_MS}`,
        `- Blacklist: name=${blacklist.name.size}, namepart=${blacklist.namepart.size}, auth=${blacklist.auth.size}, conn=${blacklist.conn.size}`,
      ].join('\n'));
      break;
    }

    // Manuel AFK (kullanıcı) + Admin hedefli AFK (!afk <id>) — TOGGLE
    case '!afk':{
      if(parts.length>=2){
        const adminPd=pdataOf(player.id);
        if(!adminPd?.isAdmin){ pmTag(player.id,'admin gerekli.'); break; }
        const tid=Number(parts[1]);
        if(!Number.isInteger(tid)||!playerData[tid]){ pmTag(player.id,'geçersiz ID.'); break; }
        const tpd=pdataOf(tid); const tp=getPlayer(tid);
        if(tpd.isAFK){
          // KALDIR
          if(isJailed(tid)){ pmTag(player.id,'hedef jailde, AFK kaldırılsa da oyuna giremez.'); break; }
          tpd.isAFK=false; putBackBalanced(tid);
          const tag = tp?` • ${getAuthConnTag(tp,true)}`:'';
          system(`⛱️ Admin: ${displayNameById(tid)} AFK KALDIRILDI.${tag}`);
          pmTag(tid,'AFK durumun kaldırıldı. Oyuna döndün.');
        } else {
          // VER
          tpd.isAFK=true;
          if(tp?.team!==0) safe(()=>room.setPlayerTeam(tid,0));
          const tag = tp?` • ${getAuthConnTag(tp,true)}`:'';
          system(`⛱️ Admin: ${displayNameById(tid)} AFK yapıldı.${tag}`);
          pmTag(tid,'Admin tarafından AFK durumuna alındın. !gir ile oyuna dönebilirsin.');
        }
        const a=findActiveVoteEntry(); if(a) evaluateVote(a.targetId);
        break;
      }
      // KULLANICI TOGGLE
      if(isJailed(player.id)){
        if(isAFK(player.id)) { pmTag(player.id,'jaildeyken AFK kaldıramazsın.'); }
        else { pmTag(player.id,'jaildeyken zaten oyuna giremezsin; AFK ihtiyacı yok.'); }
        break;
      }
      if(pd.isAFK){
        pd.isAFK=false; putBackBalanced(player.id);
        pmTag(player.id,'AFK kapattın, oyuna döndün.');
      } else {
        pd.isAFK=true; if(getPlayer(player.id)?.team!==0) safe(()=>room.setPlayerTeam(player.id,0));
        pmTag(player.id,'AFK moduna geçtin ve seyirciye alındın. Dönüş: !gir');
      }
      const a=findActiveVoteEntry(); if(a) evaluateVote(a.targetId);
      break;
    }

    // Admin giriş
    case '!admin':{
      if(parts.length<2){ pmTag(player.id,'kullanım: !admin <şifre>'); break; }
      if(parts[1]===ADMIN_PASSWORD){
        pdataOf(player.id).isAdmin=true; pdataOf(player.id).seesJailChat=true;
        safe(()=>room.setPlayerAdmin(player.id,true));
        pmTag(player.id,'admin oldun. (Jail sohbeti: Açık)');
      } else pmTag(player.id,'yanlış şifre.');
      break;
    }
    case '!gor':{
      const pp=pdataOf(player.id); if(!pp?.isAdmin){ pmTag(player.id,'admin gerekli.'); break; }
      pp.seesJailChat=!pp.seesJailChat; pmTag(player.id,`Jail sohbeti: ${pp.seesJailChat?'Açık':'Kapalı'}`); break;
    }
    case '!mesaj':{
      const pp=pdataOf(player.id); if(!pp?.isAdmin){ pmTag(player.id,'admin gerekli.'); break; }
      const text=parts.slice(1).join(' ').trim(); if(!text){ pmTag(player.id,'kullanım: !mesaj <yazı>'); break; }
      let sent=0; const sender=displayNameById(player.id);
      room.getPlayerList().forEach(p=>{
        const rpd=pdataOf(p.id); if(!rpd) return;
        const watch=rpd.isAdmin&&rpd.seesJailChat===true;
        if(isJailed(p.id)||watch){ safeSendChat(`[JAIL-ADMIN] ${sender}: ${text}`, p.id); sent++; }
      });
      pmTag(player.id, sent? `jail kanalına iletildi (${sent} alıcı).` : 'jailde kimse yok.');
      break;
    }

    // Admin AUTH/CONN görüntüleme
    case '!auth':{
      const pp=pdataOf(player.id); if(!pp?.isAdmin){ pmTag(player.id,'admin gerekli.'); break; }
      if(parts.length<2){ pmTag(player.id,'kullanım: !auth <id>'); break; }
      const tid=Number(parts[1]); const tp=getPlayer(tid);
      if(!tp){ pmTag(player.id,'ID bulunamadı.'); break; }
      pmTag(player.id, `ID:${tid} ${tp.name} • AUTH=${tp.auth||'(yok)'} • CONN=${tp.conn||'(yok)'}`);
      break;
    }

    // Oda şifresi
    case '!sifre':{
      const pp=pdataOf(player.id); if(!pp?.isAdmin){ pmTag(player.id,'admin gerekli.'); break; }
      const pass=parts.slice(1).join(' ').trim(); if(!pass){ pmTag(player.id,'kullanım: !sifre <şifre>'); break; }
      try{ if(typeof room.setPassword==='function'){ room.setPassword(pass); system('🔒 Oda şifresi güncellendi.'); }
           else pmTag(player.id,'bu headless sürümünde şifre yok.'); }
      catch(e){ pmTag(player.id,'şifre ayarlanamadı: '+e); }
      break;
    }
    case '!sifreac':{
      const pp=pdataOf(player.id); if(!pp?.isAdmin){ pmTag(player.id,'admin gerekli.'); break; }
      try{ if(typeof room.setPassword==='function'){ room.setPassword(null); system('🔓 Oda şifresi kaldırıldı.'); }
           else pmTag(player.id,'bu headless sürümünde şifre yok.'); }
      catch(e){ pmTag(player.id,'şifre kaldırılamadı: '+e); }
      break;
    }

    // Oyuncu listesi
    case '!players':{
      let s='Oyuncular:\n';
      room.getPlayerList().forEach(p=>{ if(!isHost(p)) s+=`ID:${p.id} | ${p.name} | Team:${p.team}\n`; });
      sendPrivate(player.id,s.trim()); break;
    }

    // Mute/Ban
    case '!mute':
    case '!unmute':{
      const isMute=cmd==='!mute'; const pp=pdataOf(player.id);
      if(!pp?.isAdmin){ pmTag(player.id,'admin gerekli.'); break; }
      if(parts.length<2){ pmTag(player.id,`kullanım: ${cmd} <id>`); break; }
      const tid=Number(parts[1]); if(!Number.isInteger(tid)||!playerData[tid]){ pmTag(player.id,'geçersiz ID.'); break; }
      playerData[tid].mutedByAdmin=isMute; pmTag(player.id,`oyuncu ${tid} ${isMute?'susturuldu':'açıldı'}.`); break;
    }
    case '!ban':{
      const pp=pdataOf(player.id); if(!pp?.isAdmin){ pmTag(player.id,'admin gerekli.'); break; }
      if(parts.length<2){ pmTag(player.id,'kullanım: !ban <id>'); break; }
      const tid=Number(parts[1]); const t=getPlayer(tid); if(!t){ pmTag(player.id,'ID bulunamadı.'); break; }
      safe(()=>room.kickPlayer(t.id,'Admin tarafından banlandı.',true)); pmTag(player.id,`oyuncu ${tid} banlandı.`); break;
    }
    case '!unban':{
      const pp=pdataOf(player.id); if(!pp?.isAdmin){ pmTag(player.id,'admin gerekli.'); break; }
      if(typeof room.clearBanList==='function'){ safe(()=>room.clearBanList()); pmTag(player.id,'tüm yasaklar kaldırıldı.'); }
      else pmTag(player.id,'unban desteklenmiyor.'); break;
    }

    // Oyun başlat/jail
    case '!start':{
      const pp=pdataOf(player.id); if(!pp?.isAdmin){ pmTag(player.id,'admin gerekli.'); break; }
      const unassigned=room.getPlayerList().filter(p=>p.team===0 && !isAFK(p.id) && !isHost(p));
      let r=room.getPlayerList().filter(p=>p.team===1&&!isHost(p)).length;
      let b=room.getPlayerList().filter(p=>p.team===2&&!isHost(p)).length;
      for(const p of unassigned){ safe(()=>{ if(r<=b){ room.setPlayerTeam(p.id,1); r++; } else { room.setPlayerTeam(p.id,2); b++; } }); }
      safeStartGame(); system('▶️ !start: takımlar atandı ve oyun başladı.'); break;
    }
    case '!jail':{
      const pp=pdataOf(player.id); if(!pp?.isAdmin){ pmTag(player.id,'admin gerekli.'); break; }
      if(parts.length<3){ pmTag(player.id,'kullanım: !jail <dk> <id>'); break; }
      const mins=Number(parts[1]), tid=Number(parts[2]);
      if(!Number.isFinite(mins)||mins<=0||!Number.isInteger(tid)||!playerData[tid]){ pmTag(player.id,'geçersiz.'); break; }
      playerData[tid].jailedUntil = now()+mins*60_000; savePersistentFrom(tid);
      const tp=getPlayer(tid); const tag = tp?` • ${getAuthConnTag(tp,true)}`:'';
      pmTag(player.id,`oyuncu ${tid} ${mins} dk jail.`); system(`⛓️ Admin: ${displayNameById(tid)} ${mins} dk jail.${tag}`);
      pmTag(tid,`cezan ${mins} dk. !ceza ile bak.`); break;
    }
    case '!ceza':{
      if(isJailed(player.id)){ const rem=pdataOf(player.id).jailedUntil-now();
        const m=Math.floor(rem/60000), s=Math.floor((rem%60000)/1000);
        pmTag(player.id,`kalan ceza: ${m} dk ${s} sn.`); }
      else pmTag(player.id,'aktif ceza yok.'); break;
    }
    case '!gir':{
      if(isJailed(player.id)){ pmTag(player.id,'jaildeyken oyuna dönemezsin.'); break; }
      pdataOf(player.id).isAFK=false; putBackBalanced(player.id);
      pmTag(player.id,'oyuna döndün.'); startGameTimerIfNeeded(); break;
    }

    // Anti-Multi eski komutlar
    case '!multi':{
      const pp=pdataOf(player.id); if(!pp?.isAdmin){ pmTag(player.id,'admin gerekli.'); break; }
      const action=normalizeCmdWord((parts[1]||''));
      if(/^(on|ac|aç|enable|1|true|aktif|open)$/.test(action)){
        antiMultiByAuthEnabled=true; antiMultiByConnEnabled=true; system('🛡️ Anti-Multi: AUTH+CONN **AÇIK**');
      } else if(/^(off|kapa|kapali|kapalı|disable|0|false|pasif|close)$/.test(action)){
        antiMultiByAuthEnabled=false; antiMultiByConnEnabled=false; system('🛡️ Anti-Multi: AUTH+CONN **KAPALI**');
      } else { pmTag(player.id, `Anti-Multi Durum\n- Auth: ${antiMultiByAuthEnabled?'AÇIK':'KAPALI'}\n- Conn: ${antiMultiByConnEnabled?'AÇIK':'KAPALI'}`); }
      break;
    }
    case '!multiauth':{
      const pp=pdataOf(player.id); if(!pp?.isAdmin){ pmTag(player.id,'admin gerekli.'); break; }
      const action=normalizeCmdWord((parts[1]||''));
      if(/^(on|ac|aç|enable|1|true|aktif|open)$/.test(action)){ antiMultiByAuthEnabled=true; system('🛡️ Anti-Multi AUTH: **AÇIK**'); }
      else if(/^(off|kapa|kapali|kapalı|disable|0|false|pasif|close)$/.test(action)){ antiMultiByAuthEnabled=false; system('🛡️ Anti-Multi AUTH: **KAPALI**'); }
      else pmTag(player.id,'kullanım: !multiauth on|off');
      break;
    }
    case '!multiconn':{
      const pp=pdataOf(player.id); if(!pp?.isAdmin){ pmTag(player.id,'admin gerekli.'); break; }
      const action=normalizeCmdWord((parts[1]||''));
      if(/^(on|ac|aç|enable|1|true|aktif|open)$/.test(action)){ antiMultiByConnEnabled=true; system('🛡️ Anti-Multi CONN: **AÇIK**'); }
      else if(/^(off|kapa|kapali|kapalı|disable|0|false|pasif|close)$/.test(action)){ antiMultiByConnEnabled=false; system('🛡️ Anti-Multi CONN: **KAPALI**'); }
      else pmTag(player.id,'kullanım: !multiconn on|off');
      break;
    }

    // Anti-Multi PRO yeni komutlar
    case '!multilogin':{
      const pp=pdataOf(player.id); if(!pp?.isAdmin){ pmTag(player.id,'admin gerekli.'); break; }
      const action=normalizeCmdWord((parts[1]||''));
      if(/^(on|ac|aç|enable|1|true|aktif|open)$/.test(action)){ MULTI_ALLOW_MULTI_LOGIN=true; system('🧪 MultiLogin (sekme) **AÇIK**'); }
      else if(/^(off|kapa|kapali|kapalı|disable|0|false|pasif|close)$/.test(action)){ MULTI_ALLOW_MULTI_LOGIN=false; system('🛡️ MultiLogin **KAPALI**'); }
      else pmTag(player.id,'kullanım: !multilogin on|off');
      break;
    }
    case '!multiwindow':{
      const pp=pdataOf(player.id); if(!pp?.isAdmin){ pmTag(player.id,'admin gerekli.'); break; }
      const sec=Number(parts[1]); if(!Number.isFinite(sec) || sec<0){ pmTag(player.id,'kullanım: !multiwindow <saniye> (0=kapalı)'); break; }
      MULTI_REJOIN_WINDOW_MS = Math.floor(sec*1000);
      system(`⏱️ Re-join kilidi: ${sec|0} sn`);
      break;
    }
    case '!blacklist':{
      const pp=pdataOf(player.id); if(!pp?.isAdmin){ pmTag(player.id,'admin gerekli.'); break; }
      const typ=normalizeCmdWord(parts[1]||''); const action=normalizeCmdWord(parts[2]||'');
      if(!/^(name|namepart|auth|conn)$/.test(typ) || !/^(add|list|clear)$/.test(action)){
        pmTag(player.id,'kullanım: !blacklist <name|namepart|auth|conn> add <değer> | list | clear'); break;
      }
      if(action==='add'){
        const val = parts.slice(3).join(' ').trim();
        if(!val){ pmTag(player.id,'kullanım: !blacklist '+typ+' add <değer>'); break; }
        if(typ==='namepart') blacklist[typ].add(val.toLocaleLowerCase()); else blacklist[typ].add(val);
        system(`⛔ blacklist (${typ}) eklendi: ${val}`);
      } else if(action==='list'){
        const arr=[...blacklist[typ].values()];
        sendPrivate(player.id, `blacklist ${typ} (${arr.length}): ${arr.join(', ')||'(boş)'}`);
      } else {
        blacklist[typ].clear(); system(`♻️ blacklist ${typ} temizlendi`);
      }
      break;
    }

    // ——— Af Talebi ———
    case '!aftalep':{
      const pp=pdataOf(player.id); if(!pp?.isSpammer){ pmTag(player.id,'af talebi sadece spamcı için.'); break; }
      if(parts.length<2){ pmTag(player.id,'kullanım: !aftalep <mesaj>'); break; }
      if(anyActiveVote()){ pmTag(player.id,'aktif bir oylama zaten var.'); break; }
      const reason=parts.slice(1).join(' ');
      pp.ongoingVote={ kind:'pardon', initiator:player.id, description:reason, startedAt:now(),
        durationMs:VOTE_DURATION_MS, votes:new Map(), evetSayisi:0, hayirSayisi:0, timer:null };
      pp.defenseFreeUntil = now()+AF_DEFENSE_TOTAL_MS;
      const need=requiredVotesCount(player.id);
      system(`📢 Af Talebi! Hedef: ${displayNameById(player.id)} — "${reason}"
Oy ver: !evetaf / !hayiraf • Anında kaldırma için: ${need} EVET (~%${Math.round(VOTE_THRESHOLD*100)}) • Final: 3 dk
🗣️ Savunma penceresi: 10 sn (ilk 5 sn ardışık yazabilir).`);
      pmTag(player.id,'af talebin açıldı. 10 sn savunma hakkın var.');
      eligibleVotersList(player.id).forEach(u=> pmTag(u.id, `AF: Hedef ${displayNameById(player.id)} • Oy: !evetaf/!hayiraf`) );
      scheduleVoteTimeout(player.id); break;
    }
    case '!evetaf':
    case '!hayiraf':{
      const val=(cmd==='!evetaf')?'evet':'hayir';
      if(isJailed(player.id)){ pmTag(player.id,'jailde oy yok.'); break; }
      if(isAFK(player.id)){ pmTag(player.id,'AFK iken oy yok.'); break; }
      if(pdataOf(player.id)?.isSpammer){ pmTag(player.id,'spamcı rolündeyken oy kullanamazsın.'); break; }
      const active=findActiveVoteEntry(); if(!active){ pmTag(player.id,'aktif af oylaması yok.'); break; }
      const {targetId, vote}=active; if((vote.kind||'trial')!=='pardon'){ pmTag(player.id,'aktif oylama af değil.'); break; }
      if(!isEligibleVoter(player.id,targetId)){ pmTag(player.id,'oy kullanmaya uygun değilsin.'); break; }
      if(vote.votes.has(player.id)){ pmTag(player.id,'zaten oy kullandın.'); break; }
      vote.votes.set(player.id,val); recomputeTallies(targetId);
      const need = requiredVotesCount(targetId);
      if(voteFeedPublic){
        const voter=displayNameById(player.id); const tp=getPlayer(targetId); const tname=tp?`${tp.name}(ID:${targetId})`:`ID:${targetId}`;
        system(`🗳️ [AF] ${voter} ${val.toUpperCase()} verdi • Hedef: ${tname} • Evet: ${pdataOf(targetId).ongoingVote.evetSayisi}/${need} • Hayır: ${pdataOf(targetId).ongoingVote.hayirSayisi}`);
      }
      evaluateVote(targetId);
      break;
    }

    // ——— Dava ———
    case '!dava':{
      if(parts.length<3){ pmTag(player.id,'kullanım: !dava <id> <sebep>'); break; }
      const tid=Number(parts[1]); if(!Number.isInteger(tid)||!playerData[tid]){ pmTag(player.id,'geçersiz ID.'); break; }
      if(tid===player.id){ pmTag(player.id,'kendine dava açamazsın.'); break; }
      if(anyActiveVote()){ pmTag(player.id,'aktif dava var.'); break; }
      const reason=parts.slice(2).join(' ');
      playerData[tid].ongoingVote={ kind:'trial', initiator:player.id, description:reason, startedAt:now(),
        durationMs:VOTE_DURATION_MS, votes:new Map(), evetSayisi:0, hayirSayisi:0, timer:null };
      const tp=getPlayer(tid), tname=tp?tp.name:`ID:${tid}`;
      const need=requiredVotesCount(tid);
      const authOpen = tp?.auth || '(yok)';
      const connMask = maskConn(tp?.conn);
      system(`📢 Dava! Hedef: ${tname} (${tid}) — ${reason} — AUTH:${authOpen} • CONN:${connMask} — Oy: !evet / !hayir — Anında jail için: ${need} EVET (~%${Math.round(VOTE_THRESHOLD*100)}) — Final: 3 dk`);
      pmTag(tid, `aleyhine dava açıldı: "${reason}". İtirazlarını chatten yaz.`);
      eligibleVotersList(tid).forEach(u=> pmTag(u.id, `Dava: Hedef ${tname} • Oy: !evet/!hayir`) );
      scheduleVoteTimeout(tid); break;
    }
    case '!evet':
    case '!hayir':{
      const val=(cmd==='!evet')?'evet':'hayir';
      if(isJailed(player.id)){ pmTag(player.id,'jailde oy yok.'); break; }
      if(isAFK(player.id)){ pmTag(player.id,'AFK iken oy yok.'); break; }
      if(pdataOf(player.id)?.isSpammer){ pmTag(player.id,'spamcı rolündeyken oy kullanamazsın.'); break; }
      const active=findActiveVoteEntry(); if(!active){ pmTag(player.id,'aktif dava yok.'); break; }
      const {targetId, vote}=active; if((vote.kind||'trial')!=='trial'){ pmTag(player.id,'aktif olan af oylaması.'); break; }
      if(!isEligibleVoter(player.id,targetId)){ pmTag(player.id,'oy kullanmaya uygun değilsin.'); break; }
      if(vote.votes.has(player.id)){ pmTag(player.id,'zaten oy kullandın.'); break; }
      vote.votes.set(player.id,val); recomputeTallies(targetId);

      const pdT=pdataOf(targetId); let evetList=[], hayirList=[];
      if(pdT?.ongoingVote){
        for(const [uid,vv] of pdT.ongoingVote.votes.entries()){
          const id=Number(uid); if(!isEligibleVoter(id,targetId)) continue;
          const pp=getPlayer(id); const ad=pp?`${pp.name}(ID:${id})`:`ID:${id}`;
          if(vv==='evet') evetList.push(ad); else hayirList.push(ad);
        }
      }
      const need=requiredVotesCount(targetId);
      sendPrivate(player.id, `Oy: ${val.toUpperCase()}
Evet: ${pdT.ongoingVote.evetSayisi} (${evetList.join(', ')||'Yok'})
Hayır: ${pdT.ongoingVote.hayirSayisi} (${hayirList.join(', ')||'Yok'})
Anında karar için gerekli EVET: ${need}`);

      if(voteFeedPublic){
        const voter=displayNameById(player.id); const tp=getPlayer(targetId); const tname=tp?`${tp.name}(ID:${targetId})`:`ID:${targetId}`;
        system(`🗳️ ${voter} ${val.toUpperCase()} verdi • Hedef: ${tname} • Evet: ${pdT.ongoingVote.evetSayisi}/${need} • Hayır: ${pdT.ongoingVote.hayirSayisi}`);
      }
      evaluateVote(targetId); break;
    }

    // Spam ayarları
    case '!setspam':{
      const pp=pdataOf(player.id); if(!pp?.isAdmin){ pmTag(player.id,'admin gerekli.'); break; }
      const warn=Number(parts[1]), trig=Number(parts[2]), cool=Number(parts[3]);
      if(!Number.isFinite(warn)||!Number.isFinite(trig)||!Number.isFinite(cool)){ pmTag(player.id,'kullanım: !setspam <uyarıSay> <tetikMs> <cooldownMs>'); break; }
      SPAM_WARNINGS_BEFORE_ROLE=Math.max(1,Math.floor(warn));
      SPAM_TRIGGER_MS=Math.max(100,Math.floor(trig));
      SPAM_INITIAL_COOLDOWN_MS=Math.max(1000,Math.floor(cool));
      system(`⚙️ Spam ayarları → uyarı:${SPAM_WARNINGS_BEFORE_ROLE}, tetikMs:${SPAM_TRIGGER_MS}, cooldownMs:${SPAM_INITIAL_COOLDOWN_MS}`);
      break;
    }
    case '!spamci':{
      const pp=pdataOf(player.id); if(!pp?.isAdmin){ pmTag(player.id,'admin gerekli.'); break; }
      if(parts.length<2){ pmTag(player.id,'kullanım: !spamci <id>'); break; }
      const tid=Number(parts[1]); if(!Number.isInteger(tid)||!playerData[tid]){ pmTag(player.id,'geçersiz ID.'); break; }
      const tp=pdataOf(tid); const pl=getPlayer(tid);
      tp.isSpammer=true; tp.spamWarnings=SPAM_WARNINGS_BEFORE_ROLE; tp.spamCooldownMs=SPAM_INITIAL_COOLDOWN_MS;
      tp.lastAllowedAt=now(); tp.spamBlockCount=0; savePersistentFrom(tid);
      const tag = pl?` • ${getAuthConnTag(pl,true)}`:'';
      system(`🚫 Admin: ${displayNameById(tid)} spamcı oldu.${tag}`); pmTag(tid,'admin seni spamcı yaptı. Af: !aftalep <gerekçe>.');
      break;
    }
    case '!spamkaldir':{
      const pp=pdataOf(player.id); if(!pp?.isAdmin){ pmTag(player.id,'admin gerekli.'); break; }
      if(parts.length<2){ pmTag(player.id,'kullanım: !spamkaldir <id>'); break; }
      const tid=Number(parts[1]); if(!Number.isInteger(tid)||!playerData[tid]){ pmTag(player.id,'geçersiz ID.'); break; }
      const tp=pdataOf(tid); const pl=getPlayer(tid);
      tp.isSpammer=false; tp.spamWarnings=0; tp.spamCooldownMs=SPAM_INITIAL_COOLDOWN_MS; tp.spamBlockCount=0; tp.defenseFreeUntil=0;
      savePersistentFrom(tid);
      const tag = pl?` • ${getAuthConnTag(pl,true)}`:'';
      system(`🧹 Admin: ${displayNameById(tid)} için spamcı rolü kaldırıldı.${tag}`); pmTag(tid,'admin spamcı rolünü kaldırdı.');
      break;
    }

    // YENİ: Spam kuralını global aç/kapa
    case '!spamkuralac':{
      const pp=pdataOf(player.id); if(!pp?.isAdmin){ pmTag(player.id,'admin gerekli.'); break; }
      SPAM_RULES_ENABLED = true; system('🟢 Spam kuralı: AÇIK'); break;
    }
    case '!spamkuralkaldir':{
      const pp=pdataOf(player.id); if(!pp?.isAdmin){ pmTag(player.id,'admin gerekli.'); break; }
      SPAM_RULES_ENABLED = false; system('⛔ Spam kuralı: KAPALI (mesajlara spam kontrolü uygulanmayacak)'); break;
    }

    case '!votefeed':{
      const pp=pdataOf(player.id); if(!pp?.isAdmin){ pmTag(player.id,'admin gerekli.'); break; }
      const action=normalizeCmdWord((parts[1]||''));
      if(/^(on|ac|aç|enable|1|true|aktif|open)$/.test(action)) { voteFeedPublic=true; system('📢 VoteFeed: AÇIK'); }
      else if(/^(off|kapa|kapali|kapalı|disable|0|false|pasif|close)$/.test(action)) { voteFeedPublic=false; system('📵 VoteFeed: KAPALI'); }
      else pmTag(player.id,'kullanım: !votefeed on|off');
      break;
    }

    default:
      pmTag(player.id, `bilinmeyen komut: ${partsRaw[0]}`);
  }

  return false;
};
