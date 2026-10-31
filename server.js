import 'dotenv/config';
import express from 'express';
import session from 'express-session';
import FileStoreFactory from 'session-file-store';
import tmi from 'tmi.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const ROOT=path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR=process.env.DATA_DIR||path.join(ROOT,'data');
fs.mkdirSync(DATA_DIR,{recursive:true});
const FILE=path.join(DATA_DIR,'state.json');
const TOKEN_FILE=path.join(DATA_DIR,'twitch-auth.json');
const SPOTIFY_FILE=path.join(DATA_DIR,'spotify-auth.json');
if(!fs.existsSync(FILE)){
  const bundled=path.join(ROOT,'data','state.json');
  if(bundled!==FILE && fs.existsSync(bundled)){
    fs.copyFileSync(bundled,FILE);
  }else{
    const initialState={commands:[],timers:[],birthdays:{},settings:{birthdayMessage:'🎂 Alles Gute zum Geburtstag, @{user}! 💙',birthdayAnnouncements:true,globalCooldown:5}};
    fs.writeFileSync(FILE,JSON.stringify(initialState,null,2));
  }
}
const CLIENT_ID=process.env.TWITCH_CLIENT_ID||'';
const CLIENT_SECRET=process.env.TWITCH_CLIENT_SECRET||'';
const REDIRECT_URI=process.env.TWITCH_REDIRECT_URI||'http://localhost:3000/auth/twitch/callback';
const SPOTIFY_CLIENT_ID=process.env.SPOTIFY_CLIENT_ID||'';
const SPOTIFY_CLIENT_SECRET=process.env.SPOTIFY_CLIENT_SECRET||'';
const SPOTIFY_REDIRECT_URI=process.env.SPOTIFY_REDIRECT_URI||'http://127.0.0.1:3000/auth/spotify/callback';
const BOT_USERNAME=(process.env.TWITCH_BOT_USERNAME||'').toLowerCase();
const OAUTH_SCOPES=['chat:read','chat:edit','clips:edit'];
const channel=(process.env.TWITCH_CHANNEL||'vullco').replace(/^#/,'').toLowerCase();
const app=express();
app.disable('x-powered-by');
app.use(express.json({limit:'64kb'}));
const FileStore=FileStoreFactory(session);
app.use(session({store:new FileStore({path:path.join(DATA_DIR,'sessions'),ttl:12*60*60,retries:0}),name:'vullco.sid',secret:process.env.SESSION_SECRET||crypto.randomBytes(32).toString('hex'),resave:false,saveUninitialized:false,cookie:{httpOnly:true,sameSite:'lax',secure:process.env.NODE_ENV==='production'&&process.env.TRUST_PROXY==='1',maxAge:12*60*60*1000}}));
if(process.env.TRUST_PROXY==='1') app.set('trust proxy',1);
let state=JSON.parse(fs.readFileSync(FILE,'utf8'));
const runtime={botUsername:BOT_USERNAME,online:false,connected:false,lastError:'',messages:0,startedAt:Date.now(),lastBirthdayDate:'',lastBirthdayNotice:new Set()};
const timerRuntime=new Map(),cooldowns=new Map();
let twitchAuth=null, twitch=null, refreshInFlight=null, connecting=false;
let spotifyAuth=null;
try{spotifyAuth=JSON.parse(fs.readFileSync(SPOTIFY_FILE,'utf8'));}catch{}
function storeSpotifyAuth(v){spotifyAuth=v;const tmp=SPOTIFY_FILE+'.tmp';fs.writeFileSync(tmp,JSON.stringify(v,null,2),{mode:0o600});fs.renameSync(tmp,SPOTIFY_FILE);}
function spotifyReady(){return !!(SPOTIFY_CLIENT_ID&&SPOTIFY_CLIENT_SECRET&&SPOTIFY_REDIRECT_URI);}
async function spotifyToken(params){const basic=Buffer.from(SPOTIFY_CLIENT_ID+':'+SPOTIFY_CLIENT_SECRET).toString('base64');const r=await fetch('https://accounts.spotify.com/api/token',{method:'POST',headers:{Authorization:'Basic '+basic,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(params)});const d=await r.json().catch(()=>({}));if(!r.ok)throw Error('Spotify: '+(d.error_description||d.error||r.status));return d;}

try{twitchAuth=JSON.parse(fs.readFileSync(TOKEN_FILE,'utf8'));}catch{}
function storeTwitchAuth(v){twitchAuth=v;fs.mkdirSync(path.dirname(TOKEN_FILE),{recursive:true});fs.writeFileSync(TOKEN_FILE+'.tmp',JSON.stringify(v,null,2),{mode:0o600});fs.renameSync(TOKEN_FILE+'.tmp',TOKEN_FILE);}
function configured(){return !!(CLIENT_ID&&CLIENT_SECRET&&REDIRECT_URI&&BOT_USERNAME);}
async function tokenRequest(params){const r=await fetch('https://id.twitch.tv/oauth2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:CLIENT_ID,client_secret:CLIENT_SECRET,...params})});const d=await r.json().catch(()=>({}));if(!r.ok)throw Error('Twitch OAuth: '+(d.message||r.status));return d;}
async function refreshTwitch(){if(refreshInFlight)return refreshInFlight;refreshInFlight=(async()=>{if(!twitchAuth?.refresh_token)throw Error('Bot muss mit Twitch verbunden werden');const d=await tokenRequest({grant_type:'refresh_token',refresh_token:twitchAuth.refresh_token});storeTwitchAuth({...twitchAuth,access_token:d.access_token,refresh_token:d.refresh_token||twitchAuth.refresh_token,expires_at:Date.now()+d.expires_in*1000});return twitchAuth.access_token;})();try{return await refreshInFlight;}finally{refreshInFlight=null;}}
async function accessToken(){if(!twitchAuth?.access_token)throw Error('Bot nicht mit Twitch verbunden');if(Date.now()>(twitchAuth.expires_at||0)-90000)return refreshTwitch();return twitchAuth.access_token;}
async function validateTwitch(){const t=await accessToken();const r=await fetch('https://id.twitch.tv/oauth2/validate',{headers:{Authorization:'OAuth '+t}});if(r.status===401){await refreshTwitch();return validateTwitch();}if(!r.ok)throw Error('Twitch Token konnte nicht überprüft werden');const d=await r.json();if(d.login?.toLowerCase()!==BOT_USERNAME)throw Error('Twitch-Login gehört zu @'+d.login+', erwartet @'+BOT_USERNAME);if(d.client_id!==CLIENT_ID)throw Error('Token gehört zu einer anderen Twitch-App');if(!OAUTH_SCOPES.every(x=>d.scopes?.includes(x)))throw Error('Twitch-Berechtigungen fehlen');return d;}

function save(){const tmp=FILE+'.tmp';fs.writeFileSync(tmp,JSON.stringify(state,null,2));fs.renameSync(tmp,FILE);}
function safeEq(a,b){const x=crypto.createHash('sha256').update(String(a)).digest();const y=crypto.createHash('sha256').update(String(b)).digest();return crypto.timingSafeEqual(x,y);}
const auth=(req,res,next)=>req.session.admin?next():res.status(401).json({error:'Nicht eingeloggt'});
const csrf=(req,res,next)=>{if(req.method==='GET')return next();if(req.get('x-vullco-csrf')!==req.session.csrf)return res.status(403).json({error:'Ungültige Sitzung'});next()};
app.post('/api/login',(req,res)=>{if(!process.env.PANEL_PASSWORD||!safeEq(req.body?.password,process.env.PANEL_PASSWORD))return res.status(401).json({error:'Falsches Passwort'});req.session.regenerate(err=>{if(err)return res.status(500).end();req.session.admin=true;req.session.csrf=crypto.randomBytes(24).toString('hex');res.json({ok:true,csrf:req.session.csrf});});});
app.get('/api/me',(req,res)=>res.json({loggedIn:!!req.session.admin,csrf:req.session.admin?req.session.csrf:null,channel}));
app.post('/api/logout',auth,csrf,(req,res)=>req.session.destroy(()=>res.json({ok:true})));
app.get('/api/state',auth,(req,res)=>res.json({state,runtime:{...runtime,lastBirthdayNotice:undefined}}));
app.get('/api/twitch/status',auth,(req,res)=>res.json({configured:configured(),authorized:!!twitchAuth?.refresh_token,connected:runtime.connected,username:BOT_USERNAME,error:runtime.lastError}));

app.get('/api/spotify/status',auth,(req,res)=>res.json({configured:spotifyReady(),authorized:!!(spotifyAuth?.refresh_token||process.env.SPOTIFY_REFRESH_TOKEN)}));
app.get('/auth/spotify/start',auth,(req,res)=>{if(!spotifyReady())return res.status(400).send('Spotify-App noch nicht konfiguriert');const nonce=crypto.randomBytes(32).toString('hex');req.session.spotifyState=nonce;req.session.save(err=>{if(err)return res.status(500).send('Session-Fehler');const u=new URL('https://accounts.spotify.com/authorize');for(const [k,v] of Object.entries({response_type:'code',client_id:SPOTIFY_CLIENT_ID,redirect_uri:SPOTIFY_REDIRECT_URI,scope:'user-read-currently-playing',state:nonce,show_dialog:'true'}))u.searchParams.set(k,v);res.redirect(u.toString());});});
app.get('/auth/spotify/callback',auth,async(req,res)=>{const expected=req.session.spotifyState;delete req.session.spotifyState;if(!expected||typeof req.query.state!=='string'||!safeEq(expected,req.query.state))return res.status(403).send('Spotify-Verbindung abgelaufen. Bitte erneut versuchen.');if(req.query.error)return res.status(400).send('Spotify-Anmeldung abgebrochen');if(typeof req.query.code!=='string')return res.status(400).send('Kein Spotify-Code erhalten');try{const d=await spotifyToken({grant_type:'authorization_code',code:req.query.code,redirect_uri:SPOTIFY_REDIRECT_URI});if(!d.refresh_token)throw Error('Kein Spotify-Refresh-Token erhalten');storeSpotifyAuth({access_token:d.access_token,refresh_token:d.refresh_token,expires_at:Date.now()+d.expires_in*1000});res.redirect('/?spotify=connected');}catch(e){res.status(400).send('Spotify-Verbindung fehlgeschlagen: '+String(e.message).replace(/[<>&]/g,''));}});

app.get('/auth/twitch/start',auth,(req,res)=>{if(!configured())return res.status(400).send('Bitte TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET und TWITCH_BOT_USERNAME in .env setzen.');const nonce=crypto.randomBytes(32).toString('hex');req.session.twitchState=nonce;req.session.save(err=>{if(err)return res.status(500).send('Session konnte nicht gespeichert werden');const u=new URL('https://id.twitch.tv/oauth2/authorize');for(const [k,v] of Object.entries({client_id:CLIENT_ID,redirect_uri:REDIRECT_URI,response_type:'code',scope:OAUTH_SCOPES.join(' '),state:nonce,force_verify:'true'}))u.searchParams.set(k,v);res.redirect(u.toString());});});
app.get('/auth/twitch/callback',auth,async(req,res)=>{const expected=req.session.twitchState;delete req.session.twitchState;if(!expected||typeof req.query.state!=='string'||!safeEq(expected,req.query.state))return res.status(403).send('OAuth State ungültig. Bitte nochmal im Dashboard starten.');if(req.query.error)return res.status(400).send('Twitch Anmeldung abgebrochen: '+String(req.query.error));if(typeof req.query.code!=='string')return res.status(400).send('Kein OAuth-Code erhalten');try{const d=await tokenRequest({grant_type:'authorization_code',code:req.query.code,redirect_uri:REDIRECT_URI});const v=await fetch('https://id.twitch.tv/oauth2/validate',{headers:{Authorization:'OAuth '+d.access_token}});if(!v.ok)throw Error('Twitch Token konnte nicht validiert werden');const identity=await v.json();if(identity.login?.toLowerCase()!==BOT_USERNAME)throw Error('Falscher Twitch-Account: @'+identity.login+'. Bitte mit @'+BOT_USERNAME+' anmelden.');if(identity.client_id!==CLIENT_ID||!OAUTH_SCOPES.every(x=>identity.scopes?.includes(x)))throw Error('Twitch App oder Berechtigungen stimmen nicht');storeTwitchAuth({access_token:d.access_token,refresh_token:d.refresh_token,expires_at:Date.now()+d.expires_in*1000,username:identity.login});await connectTwitch();res.redirect('/?twitch=connected');}catch(e){runtime.lastError=e.message;res.status(400).send('Twitch-Verbindung fehlgeschlagen: '+String(e.message).replace(/[<>&]/g,'')+' – bitte zurück ins Dashboard.');}});

const commandName=v=>/^![a-z0-9_]{2,30}$/.test(v);
function updateCollection(type,validator){
 app.post('/api/'+type,auth,csrf,(req,res)=>{const incoming=req.body||{};if(!validator(incoming))return res.status(400).json({error:'Bitte gültige Felder eingeben'});const id=crypto.randomUUID();state[type].push({...incoming,id});save();res.json({ok:true,id});});
 app.put('/api/'+type+'/:id',auth,csrf,(req,res)=>{const i=state[type].findIndex(x=>x.id===req.params.id);if(i<0)return res.status(404).end();const incoming={...req.body,id:req.params.id};if(!validator(incoming))return res.status(400).json({error:'Ungültige Werte'});state[type][i]=incoming;save();res.json({ok:true});});
 app.delete('/api/'+type+'/:id',auth,csrf,(req,res)=>{state[type]=state[type].filter(x=>x.id!==req.params.id);save();res.json({ok:true});});
}
updateCollection('commands',v=>commandName(String(v.trigger||'').toLowerCase())&&!['!clip','!spotify','!birthday','!birthdays'].includes(String(v.trigger).toLowerCase())&&typeof v.reply==='string'&&v.reply.length<=450&&v.reply.trim().length>0&&Number(v.cooldown)>=0&&Number(v.cooldown)<=3600&&typeof v.enabled==='boolean'&&!state.commands.some(c=>c.id!==v.id&&c.trigger===v.trigger));
updateCollection('timers',v=>typeof v.message==='string'&&v.message.trim().length>0&&v.message.length<=450&&Number(v.minutes)>=1&&Number(v.minutes)<=1440&&Number(v.minMessages)>=0&&Number(v.minMessages)<=9999&&typeof v.enabled==='boolean');
function validDate(s){if(!/^\d{2}\.\d{2}$/.test(s||''))return false;const [d,m]=s.split('.').map(Number);const x=new Date(Date.UTC(2000,m-1,d));return x.getUTCDate()===d&&x.getUTCMonth()===m-1;}
app.put('/api/birthdays/:user',auth,csrf,(req,res)=>{const user=req.params.user.toLowerCase();if(!/^[a-z0-9_]{3,25}$/.test(user)||!validDate(req.body?.date))return res.status(400).json({error:'Name oder Datum ungültig'});state.birthdays[user]=req.body.date;save();res.json({ok:true});});
app.delete('/api/birthdays/:user',auth,csrf,(req,res)=>{delete state.birthdays[req.params.user.toLowerCase()];save();res.json({ok:true});});
app.put('/api/settings',auth,csrf,(req,res)=>{const v=req.body||{};if(typeof v.birthdayMessage!=='string'||v.birthdayMessage.length>400||typeof v.birthdayAnnouncements!=='boolean'||!Number.isFinite(Number(v.globalCooldown))||Number(v.globalCooldown)<0||Number(v.globalCooldown)>300)return res.status(400).json({error:'Ungültige Einstellungen'});state.settings=v;save();res.json({ok:true});});
app.use(express.static(path.join(ROOT,'public')));
app.get('*',(req,res)=>res.sendFile(path.join(ROOT,'public','index.html')));

async function connectTwitch(){
 if(connecting)return;
 connecting=true;
 try{
  await validateTwitch();
  if(twitch){try{await twitch.disconnect();}catch{}}
  twitch=new tmi.Client({options:{debug:false,skipMembership:true},identity:{username:BOT_USERNAME,password:async()=> 'oauth:'+await accessToken()},channels:[channel],connection:{secure:true,reconnect:true}});
  twitch.on('connected',()=>{runtime.connected=true;runtime.lastError='';console.log('Twitch chat verbunden:',channel)});
  twitch.on('disconnected',reason=>{runtime.connected=false;runtime.lastError=reason||'Verbindung getrennt'});
  twitch.on('message',handleMessage);
  await twitch.connect();
 }catch(e){runtime.connected=false;runtime.lastError=e.message;console.error('Twitch:',e.message);throw e;}
 finally{connecting=false;}
}
async function say(message){if(!runtime.connected||!twitch)return;try{await twitch.say(channel,String(message).slice(0,450));}catch(e){runtime.lastError=e.message;console.error('Chat:',e.message);}}
async function helix(endpoint,method='GET'){const token=await accessToken();const r=await fetch('https://api.twitch.tv/helix/'+endpoint,{method,headers:{'Client-ID':CLIENT_ID,'Authorization':'Bearer '+token}});const body=await r.json().catch(()=>({}));if(!r.ok)throw Error(body.message||`Twitch HTTP ${r.status}`);return body;}
let broadcasterId='';
async function clip(){if(!twitchAuth?.refresh_token)throw Error('Twitch-Bot nicht verbunden');if(!broadcasterId){const d=await helix('users?login='+encodeURIComponent(channel));broadcasterId=d.data?.[0]?.id;if(!broadcasterId)throw Error('Twitch-Kanal nicht gefunden');}const d=await helix('clips?broadcaster_id='+broadcasterId,'POST');const id=d.data?.[0]?.id;if(!id)throw Error('Clip konnte nicht erstellt werden');return 'https://clips.twitch.tv/'+id;}
async function spotify(){
 let token;
 if(spotifyAuth?.refresh_token){
  if(!spotifyAuth.access_token||Date.now()>(spotifyAuth.expires_at||0)-90000){
   const d=await spotifyToken({grant_type:'refresh_token',refresh_token:spotifyAuth.refresh_token});
   storeSpotifyAuth({...spotifyAuth,access_token:d.access_token,refresh_token:d.refresh_token||spotifyAuth.refresh_token,expires_at:Date.now()+d.expires_in*1000});
  }
  token=spotifyAuth.access_token;
 }else if(process.env.SPOTIFY_REFRESH_TOKEN){
  const d=await spotifyToken({grant_type:'refresh_token',refresh_token:process.env.SPOTIFY_REFRESH_TOKEN});token=d.access_token;
 }else throw Error('Spotify nicht verbunden');
 const now=await fetch('https://api.spotify.com/v1/me/player/currently-playing',{headers:{Authorization:'Bearer '+token}});
 if(now.status===204)return 'Gerade läuft nichts auf Spotify 🎧';
 if(!now.ok)throw Error('Spotify-Abfrage fehlgeschlagen ('+now.status+')');
 const song=await now.json();return song?.item?`🎵 Jetzt läuft: ${song.item.name} – ${song.item.artists?.map(a=>a.name).join(', ')} ${song.item.external_urls?.spotify||''}`:'Gerade läuft nichts auf Spotify 🎧';
}
function today(){return new Intl.DateTimeFormat('de-CH',{timeZone:'Europe/Zurich',day:'2-digit',month:'2-digit'}).format(new Date()).replaceAll('/','.');}
function dailyBirthdays(){const d=today();if(runtime.lastBirthdayDate!==d){runtime.lastBirthdayDate=d;runtime.lastBirthdayNotice=new Set();}return Object.entries(state.birthdays).filter(([,date])=>date===d).map(([user])=>user);}
function cool(key,seconds){const now=Date.now();if((cooldowns.get(key)||0)>now)return true;cooldowns.set(key,now+seconds*1000);return false;}
function mod(tags){return tags.mod||tags.badges?.broadcaster==='1';}
async function handleMessage(_ch,tags,message,self){if(self)return;runtime.messages++;const user=tags.username?.toLowerCase()||'';const [command,arg]=message.trim().split(/\s+/,2);const cmd=command?.toLowerCase();if(!cmd?.startsWith('!'))return;
 if(cool('user:'+user+':'+cmd,3))return;
 if(cmd==='!clip'){if(cool('clip-global',60))return;try{await say('🎬 Clip erstellt: '+await clip());}catch(e){console.error('Clip:',e.message);await say('Clip konnte gerade nicht erstellt werden. Bitte Twitch-Verbindung prüfen.');}return;}
 if(cmd==='!spotify'){if(cool('spotify-global',15))return;try{await say(await spotify());}catch(e){console.error('Spotify:',e.message);await say('Spotify ist gerade nicht verfügbar.');}return;}
 if(cmd==='!birthday'){if(!arg){await say(`@${user} Dein Geburtstag: ${state.birthdays[user]||'noch nicht eingetragen'}. Mit !birthday TT.MM speichern, mit !birthday remove löschen.`);return;}if(arg==='remove'){delete state.birthdays[user];save();await say(`@${user} dein Geburtstag wurde gelöscht.`);return;}if(!validDate(arg)){await say(`@${user} bitte TT.MM verwenden, z. B. !birthday 24.08`);return;}state.birthdays[user]=arg;save();await say(`🎂 @${user}, dein Geburtstag am ${arg} ist gespeichert (ohne Geburtsjahr)!`);return;}
 if(cmd==='!birthdays'){const names=dailyBirthdays();await say(names.length?`🎂 Heute haben Geburtstag: ${names.map(n=>'@'+n).join(', ').slice(0,330)}`:'🎂 Heute ist noch kein Geburtstag eingetragen.');return;}
 const match=state.commands.find(c=>c.enabled&&c.trigger.toLowerCase()===cmd);if(match&&!cool('custom:'+cmd,Number(match.cooldown)||0))await say(match.reply.replaceAll('{user}',user).replaceAll('{streamer}',channel));
}
setInterval(async()=>{if(!runtime.connected)return;for(const t of state.timers){if(!t.enabled)continue;const r=timerRuntime.get(t.id)||{last:Date.now(),messages:runtime.messages};if(Date.now()-r.last>=Number(t.minutes)*60000&&runtime.messages-r.messages>=Number(t.minMessages)){await say(t.message.replaceAll('{streamer}',channel));r.last=Date.now();r.messages=runtime.messages;}timerRuntime.set(t.id,r);}},15000);
setInterval(async()=>{if(!state.settings.birthdayAnnouncements||!runtime.connected)return;for(const user of dailyBirthdays()){if(runtime.lastBirthdayNotice.has(user))continue;await say(state.settings.birthdayMessage.replaceAll('{user}',user));runtime.lastBirthdayNotice.add(user);}},60000);
const port=Number(process.env.PORT)||3000;
app.listen(port,()=>console.log(`Vullco Panel: http://localhost:${port}`));
if(configured()&&twitchAuth?.refresh_token)connectTwitch().catch(()=>{});else console.warn('Twitch noch nicht verbunden. Öffne das Dashboard und klicke auf Mit Twitch verbinden.');
setInterval(async()=>{if(!twitchAuth?.refresh_token||!configured())return;try{await validateTwitch();if(!runtime.connected&&!connecting)await connectTwitch();}catch(e){runtime.lastError=e.message;console.error('Twitch Refresh:',e.message);}},5*60*1000);
