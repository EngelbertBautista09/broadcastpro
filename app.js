'use strict';
// ══════════════════════════════════════════════════════
//  BROADCASTPRO FM — COMPLETE ENGINE v2
// ══════════════════════════════════════════════════════

// ─── STATE ────────────────────────────────────────────
const STATE = {
  playlist:[], nowPlayingIdx:-1, selectedPlIdx:-1,
  actionMode:'ADD', insertPos:1,
  autoplay:false, loopMode:false, assistMode:false,
  playing:false, paused:false,
  posSec:0, durSec:0,
  fileLibrary:[], folders:[], activeFolderId:null,
  searchQuery:'', genreFilter:'',
  swBanks:[], activeBankIdx:0, selectedPadIdx:-1,
  swAutoGain:false, swFadeMix:false, playingPadIdx:-1,
  samplerOpen:false, activeSamplerTab:'lyrics',
};

// ─── AUDIO ────────────────────────────────────────────
let audioCtx=null, masterAudio=null, masterSource=null;
let masterGain=null, masterAnalyser=null, masterAnalyserData=null;
let eqAHi=null, eqAMid=null, eqALo=null, gainNodeA=null;
let filterNodeA=null;
let micStream=null, micAnalyser=null, micData=null;
let micActive=false, duckTimeout=null, duckLocked=false;
let attackMs=200, releaseMs=800;
const swAudioPool={};
const fxNodes={A:{},B:{}};

// ─── DECK B INDEPENDENT AUDIO ENGINE ──────────────────
let deckBAudio=null, deckBGain=null, deckBSrc=null;
let deckBAnalyser=null, deckBAnalyserData=null;
let deckBEqHi=null, deckBEqMid=null, deckBEqLo=null;
let deckBTrackIdx=-1, deckBDragging=false;
// Which physical deck is currently the "main" playing deck.
// Starts as 'A'. After each auto-fade completes it flips to the other deck.
let activeDeck = 'A';

function initDeckBChain(){
  if(!audioCtx) initAudioCtx();
  deckBGain = deckBGain || audioCtx.createGain();
  deckBGain.gain.value = deckFaderState.B/100;
  if(!deckBAnalyser){
    deckBAnalyser = audioCtx.createAnalyser();
    deckBAnalyser.fftSize = 256;
    deckBAnalyserData = new Uint8Array(deckBAnalyser.frequencyBinCount);
    deckBGain.connect(deckBAnalyser);
    deckBAnalyser.connect(masterGain);
  } else {
    deckBGain.connect(masterGain);
  }
}

function loadDeckB(idx){
  const item = STATE.playlist[idx];
  if(!item || !item.fileObj){ showToast('No audio file at position '+(idx+1)); return; }
  initAudioCtx(); initDeckBChain();
  if(deckBAudio){ deckBAudio.pause(); deckBAudio.src=''; }
  if(deckBSrc){ try{deckBSrc.disconnect();}catch(e){} deckBSrc=null; }
  deckBAudio = new Audio();
  deckBAudio.src = URL.createObjectURL(item.fileObj);
  deckBAudio.playbackRate = 1 + tempoState.B/100;
  deckBTrackIdx = idx;
  // Drive timing display from deck B when it is the active deck
  deckBAudio.addEventListener('timeupdate', ()=>{
    if(activeDeck === 'B') onAudioTimeUpdate();
  });
  // EQ chain
  if(deckBEqHi){try{deckBEqHi.disconnect();}catch(e){}}
  deckBEqHi  = audioCtx.createBiquadFilter(); deckBEqHi.type='highshelf';  deckBEqHi.frequency.value=10000;
  deckBEqMid = audioCtx.createBiquadFilter(); deckBEqMid.type='peaking';   deckBEqMid.frequency.value=1000; deckBEqMid.Q.value=1;
  deckBEqLo  = audioCtx.createBiquadFilter(); deckBEqLo.type='lowshelf';   deckBEqLo.frequency.value=200;
  deckBAudio.addEventListener('loadedmetadata',()=>{
    if(deckBSrc){try{deckBSrc.disconnect();}catch(e){}}
    deckBSrc = audioCtx.createMediaElementSource(deckBAudio);
    deckBSrc.connect(deckBEqHi); deckBEqHi.connect(deckBEqMid);
    deckBEqMid.connect(deckBEqLo); deckBEqLo.connect(deckBGain);
    const wt = document.getElementById('waveTimeB');
    if(wt) wt.textContent = fmtDur(deckBAudio.duration||0);
  },{once:true});
  // NOTE: 'ended' handler is attached by the fade-done callback (or deckBEndedHandler)
  //        so we do NOT add one here to avoid double-fire.
  // Update deck B UI
  const s=id=>document.getElementById(id);
  if(s('deckBTitle')) s('deckBTitle').textContent=`${item.artist} – ${item.title}`;
  if(s('deckBBpm'))   s('deckBBpm').textContent=item.bpm||'—';
  if(s('deckBBadge')) s('deckBBadge').textContent=`PL:${idx+1}`;
  const ws=document.getElementById('waveStripB');
  if(ws){ws.width=ws.offsetWidth||300;ws.height=ws.offsetHeight||34;drawWaveStrip('B',item);}
  // Pre-cache waveform overview in background
  if(item.fileObj) buildWaveformOverview(item.fileObj);
  addLog('system',`Deck B loaded: ${item.artist} – ${item.title}`,fmtDur(item.duration||0));
  showToast(`Deck B: ${item.artist} – ${item.title}`);
}

function showToast(msg){
  let t=document.getElementById('bpToast');
  if(!t){
    t=document.createElement('div'); t.id='bpToast';
    t.style.cssText='position:fixed;bottom:70px;left:50%;transform:translateX(-50%);'+
      'background:#1a1a2e;border:1px solid #3a3aff44;color:#eee;font-size:10px;'+
      'font-family:Courier New,monospace;padding:6px 18px;border-radius:3px;'+
      'z-index:9999;pointer-events:none;opacity:0;transition:opacity 0.25s;white-space:nowrap;';
    document.body.appendChild(t);
  }
  t.textContent=msg; t.style.opacity='1';
  clearTimeout(t._timer);
  t._timer=setTimeout(()=>t.style.opacity='0',2800);
}

// ─── DRAG-AND-DROP FROM PLAYLIST TO DECK ──────────────
let _dragPlIdx = -1;

// onPlDragStart: see full implementation below

function onDeckDragOver(e, deck){
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  const zone = document.getElementById('deckDropZone'+deck);
  if(zone) zone.classList.add('drag-over');
}

function onDeckDragLeave(deck){
  const zone = document.getElementById('deckDropZone'+deck);
  if(zone) zone.classList.remove('drag-over');
}

function onDeckDrop(e, deck){
  e.preventDefault();
  const zone = document.getElementById('deckDropZone'+deck);
  if(zone) zone.classList.remove('drag-over');
  const idx = parseInt(e.dataTransfer.getData('text/plain'));
  if(isNaN(idx) || idx < 0) return;
  if(deck === 'A'){
    loadTrack(idx); 
    showToast('Deck A loaded: '+(STATE.playlist[idx]?.artist||'track'));
  } else {
    loadDeckB(idx);
  }
  _dragPlIdx = -1;
}

function initAudioCtx(){
  if(audioCtx) return;
  audioCtx=new(window.AudioContext||window.webkitAudioContext)();
  masterGain=audioCtx.createGain(); masterGain.gain.value=0.8;
  masterAnalyser=audioCtx.createAnalyser(); masterAnalyser.fftSize=256;
  masterAnalyserData=new Uint8Array(masterAnalyser.frequencyBinCount);
  masterGain.connect(masterAnalyser);
  masterAnalyser.connect(audioCtx.destination);
  animateVU();
}

function setupEQ(){
  if(!audioCtx||!masterAudio) return;
  // Disconnect old source if exists
  if(masterSource){try{masterSource.disconnect();}catch(e){} masterSource=null;}
  // createMediaElementSource throws if this audio element already has a node attached
  // (can happen when setupEQ is called twice on the same masterAudio).
  // Each fresh masterAudio element from loadTrackAndPlay/_preBufferDeckA is a new object,
  // so this only fails if something calls setupEQ twice on the same element.
  try{
    masterSource = audioCtx.createMediaElementSource(masterAudio);
  }catch(e){
    console.warn('setupEQ: MediaElementSource already exists, skipping:', e.message);
    // Reconnect gainNodeA if it exists
    if(gainNodeA) gainNodeA.connect(masterGain);
    return;
  }
  eqAHi=audioCtx.createBiquadFilter(); eqAHi.type='highshelf'; eqAHi.frequency.value=10000;
  eqAMid=audioCtx.createBiquadFilter(); eqAMid.type='peaking'; eqAMid.frequency.value=1000; eqAMid.Q.value=1;
  eqALo=audioCtx.createBiquadFilter(); eqALo.type='lowshelf'; eqALo.frequency.value=200;
  gainNodeA=audioCtx.createGain(); gainNodeA.gain.value=deckFaderState.A/100;
  masterSource.connect(eqAHi);
  eqAHi.connect(eqAMid); eqAMid.connect(eqALo); eqALo.connect(gainNodeA);
  gainNodeA.connect(masterGain);
}

// createAudioElement removed — inlined in loadTrackAndPlay

function loadTrack(idx){
  const item=STATE.playlist[idx]; if(!item) return;
  if(item.type==='youtube'){STATE.nowPlayingIdx=idx;updateNowPlayingDisplay();updateDeckDisplays();renderPlaylist();return;}
  loadTrackAndPlay(idx, false);
}

function onAudioMetadata(){
  STATE.durSec=masterAudio.duration||0;
  const item=STATE.playlist[STATE.nowPlayingIdx];
  if(item&&!item.duration){item.duration=STATE.durSec;recalcPlaylistTimes();renderPlaylist();}
  updateTimingDisplay();
}

// Deck A timeupdate — only drives display/logic when A is the active deck.
// When activeDeck='B', masterAudio is pre-buffered/silent; deckBAudio's own
// timeupdate listener (added in loadDeckB) drives the display instead.
function _deckATimeUpdate(){
  if(activeDeck !== 'A') return;
  onAudioTimeUpdate();
}

function onAudioTimeUpdate(){
  // Always read the ACTIVE deck — masterAudio when A is playing, deckBAudio when B is playing
  const activeAudio = activeDeck === 'B' && deckBAudio ? deckBAudio : masterAudio;
  STATE.posSec = activeAudio.currentTime;
  STATE.durSec = activeAudio.duration || STATE.durSec;
  updateTimingDisplay(); updateLyricsHighlight();
  updatePlNowStrip(); checkAutoFade(); updateYdjHeaders();
  // Loop check
  const ls=loopState.A;
  if(ls.active&&ls.outPoint!==null&&masterAudio.currentTime>=ls.outPoint)
    masterAudio.currentTime=ls.inPoint;
  // Outro point check — trigger next song early if outro is set
  const curItem=STATE.playlist[STATE.nowPlayingIdx];
  if(curItem?.outroSec!=null && STATE.autoplay && !STATE.assistMode){
    if(masterAudio.currentTime>=curItem.outroSec && !masterAudio._outroFired){
      masterAudio._outroFired=true;
      const nextIdx=STATE.nowPlayingIdx+1;
      if(nextIdx<STATE.playlist.length){
        addLog('system','[Outro] Advancing at '+fmtDur(curItem.outroSec),'—');
        loadTrackAndPlay(nextIdx,true);
      }
    }
  }
  // Update wavestrip remaining time display
  const remain=Math.max(0,STATE.durSec-STATE.posSec);
  const wt=document.getElementById('waveTimeA');
  if(wt) wt.textContent=fmtDur(remain);
}

function onAudioEnded(){
  // ── GUARD: when Deck B is the active deck, masterAudio is either the
  //    outgoing song (already faded out) or a pre-buffered song that hasn't
  //    started yet.  Either way we must NOT advance the playlist here — the
  //    autofade callback handles all state transitions when autoFade is on,
  //    and deckBAudio's own ended handler handles the non-autofade case.
  if(activeDeck !== 'A'){
    addLog('system','masterAudio ended (ignored — Deck B is active)','—');
    return;
  }

  STATE.playing=false;
  setPlayingUI(false);
  addLog('song','Finished: '+getCurrentTrackTitle(),'—');

  if(STATE.loopMode){
    masterAudio.currentTime=0;
    masterAudio.play().catch(()=>{});
    STATE.playing=true;
    setPlayingUI(true);
    return;
  }
  if(!STATE.autoplay){
    updateNowPlayingDisplay();
    renderPlaylist();
    return;
  }
  // Advance to next — NEVER splice the playlist (would corrupt deckBTrackIdx and autofade indices)
  recalcPlaylistTimes();
  const nextIdx = STATE.nowPlayingIdx + 1;
  if(nextIdx < STATE.playlist.length){
    if(STATE.assistMode){
      STATE.nowPlayingIdx = nextIdx;
      updateNowPlayingDisplay(); renderPlaylist();
      showToast('▶ Ready: '+(STATE.playlist[nextIdx]?.artist||'Next')+'— press PLAY');
    } else {
      loadTrackAndPlay(nextIdx, true);
    }
  } else {
    STATE.nowPlayingIdx = -1;
    addLog('system','Playlist finished','—');
    updateNowPlayingDisplay(); renderPlaylist();
  }
}
function loadTrackAndPlay(idx, autoPlay){
  const item=STATE.playlist[idx];
  if(!item){ STATE.nowPlayingIdx=idx; renderPlaylist(); return; }
  // YouTube item — open in browser panel and advance in playlist
  if(!item.fileObj && item.type==='youtube' && item.ytId){
    STATE.nowPlayingIdx=idx;
    STATE.playing=false; STATE.paused=false;
    updateNowPlayingDisplay(); renderPlaylist();
    // Open the video in the browser panel
    const embed=`https://www.youtube-nocookie.com/embed/${item.ytId}?autoplay=1&rel=0&modestbranding=1`;
    brLoadFrame(embed, '▶ '+item.title);
    brSwitchTab('yt');
    showBrowserPanel();
    addLog('song', item.title, item.duration?fmtDur(item.duration):'—');
    showToast('▶ YT: '+item.title.substring(0,40));
    // Auto-advance after duration if known
    if(item.duration && STATE.autoplay && !STATE.assistMode){
      setTimeout(()=>{
        if(STATE.nowPlayingIdx===idx){ // still on this item
          onAudioEnded();
        }
      }, (item.duration+2)*1000);
    }
    return;
  }
  if(!item.fileObj){ STATE.nowPlayingIdx=idx; renderPlaylist(); return; }
  STATE.nowPlayingIdx=idx;
  STATE.posSec=0; STATE.durSec=item.duration||0;
  initAudioCtx();
  if(masterSource){try{masterSource.disconnect();}catch(e){}masterSource=null;}
  // Create fresh audio element
  if(masterAudio){masterAudio.pause();masterAudio.src='';}
  masterAudio=new Audio();
  masterAudio.crossOrigin='anonymous';
  masterAudio.src=URL.createObjectURL(item.fileObj);
  masterAudio.playbackRate=1+tempoState.A/100;
  masterAudio.addEventListener('timeupdate', _deckATimeUpdate);
  masterAudio.addEventListener('ended',onAudioEnded);
  masterAudio.addEventListener('loadedmetadata',onAudioMetadata);
  masterAudio.addEventListener('error',()=>setPlayingUI(false));
  masterAudio._outroFired = false;
  _autoFadeFired = false;
  updateNowPlayingDisplay(); updateDeckDisplays(); renderPlaylist();
  const wA=document.getElementById('waveStripA');
  if(wA){wA.width=wA.offsetWidth||300;wA.height=wA.offsetHeight||34;drawWaveStrip('A',item);}
  if(item.fileObj) buildWaveformOverview(item.fileObj);
  const nxt=STATE.playlist[idx+1];
  if(nxt){
    const wB=document.getElementById('waveStripB');
    if(wB){wB.width=wB.offsetWidth||300;wB.height=wB.offsetHeight||34;drawWaveStrip('B',nxt);}
    if(nxt.fileObj) buildWaveformOverview(nxt.fileObj);
    // Pre-load next track onto Deck B when activeDeck is A (first play / after B→A fade)
    if(activeDeck === 'A') loadDeckB(idx+1);
  }
  if(autoPlay){
    const tryPlay=()=>{
      if(!audioCtx){initAudioCtx();}
      if(audioCtx.state==='suspended') audioCtx.resume();
      setupEQ();
      // Seek to intro point if set
      if(item.introSec!=null && item.introSec>0) masterAudio.currentTime=item.introSec;
      masterAudio.play().then(()=>{
        STATE.playing=true; STATE.paused=false;
        setPlayingUI(true);
        addLog('song',getCurrentTrackTitle(),fmtDur(STATE.durSec));
        renderPlaylist();
      }).catch(e=>{ console.warn('AutoPlay failed:',e); setPlayingUI(false); });
    };
    if(masterAudio.readyState>=2){ tryPlay(); }
    else { masterAudio.addEventListener('canplay',tryPlay,{once:true}); }

    // Auto-detect BPM after audio metadata loads (safe: doesn't compete with playback start)
    if(!item.bpm){
      masterAudio.addEventListener('loadedmetadata', ()=>autoDetectBpm('A'), {once:true});
    }
  } else {
    setupEQ();
    // Auto-detect BPM on load even without autoPlay
    if(!item.bpm){
      masterAudio.addEventListener('loadedmetadata', ()=>autoDetectBpm('A'), {once:true});
    }
  }
}

// Bottom bar play/pause toggle
function bbPlayPause(){
  if(STATE.playing){ masterPause(); return; }
  masterPlay();
}

function masterPlay(){
  initAudioCtx();
  if(audioCtx.state==='suspended') audioCtx.resume();
  if(STATE.paused && masterAudio && masterAudio.src){
    masterAudio.play().then(()=>{
      STATE.playing=true; STATE.paused=false;
      setPlayingUI(true);
    }).catch(e=>console.warn('Resume:',e));
    return;
  }
  const idx = STATE.nowPlayingIdx>=0 ? STATE.nowPlayingIdx : 0;
  if(idx < STATE.playlist.length) loadTrackAndPlay(idx, true);
}

function masterPause(){
  if(!masterAudio) return;
  masterAudio.pause(); STATE.playing=false; STATE.paused=true;
  setPlayingUI(false);
  renderPlaylist();
}

function masterStop(){
  if(masterAudio){masterAudio.pause();masterAudio.currentTime=0;}
  if(deckBAudio&&deckState.B.playing){deckBAudio.pause();deckBAudio.currentTime=0;deckState.B.playing=false;}
  STATE.playing=false; STATE.paused=false; STATE.posSec=0;
  STATE.nowPlayingIdx=-1;
  activeDeck='A'; // reset deck alternation
  setPlayingUI(false); updateTimingDisplay();
  platters.A.spinning=false; platters.B.spinning=false;
  const pb=document.getElementById('playB');
  if(pb){pb.textContent='▶ PLAY';pb.classList.remove('playing');}
  // Hide now-playing strip
  document.getElementById('plNowStrip')?.classList.remove('visible','paused');
  renderPlaylist();
  updateNowPlayingDisplay();
}

function setPlayingUI(isPlaying){
  updateNowPlayingExport();
  updatePlNowStrip();
  const btn=document.getElementById('bbPlay');
  const vinyl=document.getElementById('vinylDisc');
  const badge=document.getElementById('onAirBadge');
  if(btn){btn.textContent=isPlaying?'⏸ PAUSE':'▶ PLAY';btn.className='bb-btn bb-play'+(isPlaying?' playing':'');}
  if(vinyl) vinyl.className='vinyl'+(isPlaying?' playing':'');
  if(badge) badge.className='on-air-badge'+(isPlaying?' active':'');
  platters.A.spinning=isPlaying;
  const pA=document.getElementById('playA');
  if(pA){pA.textContent=isPlaying?'⏸ PAUSE':'▶ PLAY';pA.classList.toggle('playing',isPlaying);}
  const rA=document.getElementById('platterRpmA');
  if(rA) rA.textContent=(33.3*(1+tempoState.A/100)).toFixed(1)+' RPM · '+(isPlaying?'PLAY':'STOP');
  renderPlaylist();
}

function getCurrentTrackTitle(){
  const item=STATE.playlist[STATE.nowPlayingIdx];
  return item?`${item.artist} – ${item.title}`:'—';
}

// ─── NOW PLAYING EXPORT (RDS / metadata) ──────────────
// Writes to a data URI blob; in a real station this would POST to an RDS encoder or streaming server.
let _nowPlayingExportEl=null;
function updateNowPlayingExport(){
  const item=STATE.playlist[STATE.nowPlayingIdx];
  const meta={
    title:   item?.title  || '',
    artist:  item?.artist || '',
    duration:item?.duration||0,
    position:Math.round(STATE.posSec),
    bpm:     item?.bpm    || '',
    playing: STATE.playing,
    timestamp: new Date().toISOString(),
  };
  // Update the export badge in the header if present
  const el=document.getElementById('npExportLbl');
  if(el) el.textContent=STATE.playing?`● ${meta.artist} – ${meta.title}`:'● OFF AIR';
  // Store as window property for external scripts/OBS browser source to read
  window.BPFM_NOW_PLAYING=meta;
  // Dispatch custom event for integrations
  window.dispatchEvent(new CustomEvent('bpfm:nowplaying', {detail:meta}));
}

// ─── DISPLAY UPDATES ──────────────────────────────────
function updateNowPlayingDisplay(){
  updateNowPlayingExport();
  const item=STATE.playlist[STATE.nowPlayingIdx];
  if(!item){
    ['npArtist','npTitle','lyricsSongTitle','lyricsArtist'].forEach(id=>{const e=document.getElementById(id);if(e)e.textContent=id==='npTitle'?'No track loaded':'—';});
    return;
  }
  const e=id=>document.getElementById(id);
  if(e('npArtist')) e('npArtist').textContent=item.artist||item.title;
  if(e('npTitle'))  e('npTitle').textContent=item.title||'';
  if(e('npType'))   e('npType').textContent=item.type==='youtube'?'▶ YT':(item.fileObj?'.'+item.fileObj.name.split('.').pop().toUpperCase():'');
  if(e('lyricsSongTitle')) e('lyricsSongTitle').textContent=item.title||'—';
  if(e('lyricsArtist'))    e('lyricsArtist').textContent=item.artist||'';
  renderLyrics(item.title,item.artist);
  // Auto-fetch AI lyrics if sampler is open on lyrics tab and no lyrics cached
  if(STATE.samplerOpen && STATE.activeSamplerTab==='lyrics'){
    const key=lyricsKey(item);
    if(!lyricsStore[key]?.lines?.length){
      setTimeout(()=>autoFetchLyrics(false),600);
    }
  }
  const next=STATE.playlist[STATE.nowPlayingIdx+1];
  const nextName=next?`${next.artist} – ${next.title}`:'—';
  const nn=document.getElementById('nextUpName'); if(nn) nn.textContent=nextName;
  const nbs=document.querySelector('#bbNextUp span'); if(nbs) nbs.textContent=nextName;
}

function updateTimingDisplay(){
  const pos=STATE.posSec, dur=STATE.durSec, rem=Math.max(0,dur-pos);
  const s=id=>document.getElementById(id);
  if(s('posTime')) s('posTime').textContent=fmtDur(pos);
  if(s('curDur'))  s('curDur').textContent=fmtDur(dur);
  if(s('progPos')) s('progPos').textContent=fmtDur(pos);
  if(s('progDur')) s('progDur').textContent=fmtDur(dur);
  if(s('mainProg')) s('mainProg').style.width=dur>0?((pos/dur)*100).toFixed(2)+'%':'0%';
  if(s('remainDig')) s('remainDig').textContent=fmtDur(rem);
  const tl=Math.max(0,STATE.playlist.length-STATE.nowPlayingIdx-1);
  if(s('remainTracks')) s('remainTracks').textContent=tl+' track'+(tl!==1?'s':'')+' left';

  // Track end time (wall clock)
  if(s('trackEndTime')){
    if(dur>0 && (STATE.playing||STATE.paused)){
      const endAt = new Date(Date.now() + rem*1000);
      s('trackEndTime').textContent = endAt.toTimeString().slice(0,8);
    } else { s('trackEndTime').textContent='—'; }
  }

  // On-air elapsed (time since current track started)
  if(s('onAirElapsed')){
    s('onAirElapsed').textContent = (STATE.playing||STATE.paused) ? fmtDur(pos) : '—';
  }

  updateNextEmptySlot();
}

function updateDeckDisplays(){
  const a=STATE.playlist[STATE.nowPlayingIdx];
  const b=STATE.playlist[STATE.nowPlayingIdx+1];
  const s=id=>document.getElementById(id);
  if(s('deckATitle')) s('deckATitle').textContent=a?`${a.artist} – ${a.title}`:'No track';
  if(s('deckABpm'))   s('deckABpm').textContent=a?.bpm||'—';
  // Reset live BPM when new track loads, then re-detect if bpm known
  if(a?.bpm){ liveBpm.A=a.bpm; updateBpmDisplay('A',a.bpm,'STORED'); }
  else { liveBpm.A=null; updateBpmDisplay('A',null,'IDLE'); }
  if(b?.bpm){ liveBpm.B=b.bpm; updateBpmDisplay('B',b.bpm,'STORED'); }
  else { liveBpm.B=null; updateBpmDisplay('B',null,'IDLE'); }
  updateSyncDiff();
  if(s('deckABadge')) s('deckABadge').textContent=a?`PL:${STATE.nowPlayingIdx+1}`:'PL:—';
  if(s('deckBTitle')) s('deckBTitle').textContent=b?`${b.artist} – ${b.title}`:'No track';
  if(s('deckBBpm'))   s('deckBBpm').textContent=b?.bpm||'—';
  if(s('deckBBadge')) s('deckBBadge').textContent=b?`PL:${STATE.nowPlayingIdx+2}`:'PL:—';
  if(s('syncBpmA'))   s('syncBpmA').textContent=a?.bpm||'—';
  if(s('syncBpmB'))   s('syncBpmB').textContent=b?.bpm||'—';
  const aBpm=a?.bpm,bBpm=b?.bpm;
  if(aBpm&&bBpm&&s('syncDiff')){
    const diff=Math.abs(aBpm-bBpm).toFixed(1);
    s('syncDiff').textContent=`Δ ${diff} BPM`;
    s('syncDiff').className='sync-diff '+(parseFloat(diff)<2?'ok':'warn');
  } else if(s('syncDiff')) s('syncDiff').textContent='No BPM data';
  updateYdjHeaders();
}

function recalcPlaylistTimes(){
  let t=new Date();
  STATE.playlist.forEach((item,i)=>{
    item.schedTime=new Date(t);
    let effectiveDur = item.duration||0;
    // For current track: subtract elapsed time so upcoming times are accurate
    if(i===STATE.nowPlayingIdx && (STATE.playing||STATE.paused)){
      const activeAudio = activeDeck === 'B' && deckBAudio ? deckBAudio : masterAudio;
      const elapsed = activeAudio?.currentTime || STATE.posSec || 0;
      effectiveDur = Math.max(0, effectiveDur - elapsed);
    }
    // Use outro point if set (track hands off early)
    if(item.outroSec!=null && item.outroSec < effectiveDur) effectiveDur=item.outroSec;
    t=new Date(t.getTime()+effectiveDur*1000);
  });
  updateNextEmptySlot();
}

function updateNextEmptySlot(){
  let t=new Date();
  STATE.playlist.forEach(item=>{if(item.fileObj||item.url) t=new Date(t.getTime()+(item.duration||0)*1000);});
  const secsFromNow=Math.round((t-Date.now())/1000);
  const s=id=>document.getElementById(id);
  if(s('neTime'))      s('neTime').textContent=t.toTimeString().slice(0,8);
  if(s('neCountdown')) s('neCountdown').textContent=secsFromNow>0?` (in ${fmtDur(secsFromNow)})`:'';
  const totalSec=STATE.playlist.reduce((a,i)=>a+(i.duration||0),0);
  if(s('plTotalDur')) s('plTotalDur').textContent=totalSec>0?'⏱ '+fmtDur(totalSec):'—';
  if(s('plStats'))    s('plStats').textContent=STATE.playlist.length+' item'+(STATE.playlist.length!==1?'s':'');
}

// ─── PLAYLIST ─────────────────────────────────────────
function renderPlaylist(){
  const c=document.getElementById('plList'); if(!c) return;
  const nowIdx=STATE.nowPlayingIdx;
  const isActive=STATE.playing||STATE.paused;

  // ── Update the NOW PLAYING sticky card ──
  updatePlNowStrip();

  if(!STATE.playlist.length){
    c.innerHTML='<div style="padding:16px;text-align:center;color:var(--text3);font-size:10px;">Playlist empty.<br>Double-click a file to add.</div>';
    updateNextEmptySlot(); return;
  }

  // Queue: only show songs AFTER the current one — numbered 1, 2, 3...
  // Current song lives exclusively in the NOW PLAYING card above.
  // Past songs are spliced out when they finish, so they never appear here.
  const queueItems = STATE.playlist
    .map((item,i)=>({item,i}))
    .filter(({i})=> !isActive || i > nowIdx);

  if(!queueItems.length && isActive){
    c.innerHTML='<div style="padding:16px;text-align:center;color:var(--text3);font-size:10px;line-height:1.8;">Queue is empty.<br><span style="font-size:9px;">Drag files here or double-click in the library.</span></div>';
    updateNextEmptySlot(); return;
  }

  const rows = queueItems.map(({item,i}, queuePos)=>{
    const isNext = queuePos===0 && isActive; // first in queue = NEXT
    const isSel  = i===STATE.selectedPlIdx;
    const ts = item.schedTime ? item.schedTime.toTimeString().slice(0,8) : '—';
    const tb = item.type==='youtube'
      ? '<span class="badge b-yt">YT</span>'
      : item.fileObj ? `<span class="badge b-mp3">.${item.fileObj.name.split('.').pop().toUpperCase()}</span>` : '';

    const statusBadge = isNext
      ? '<span style="background:#3a8fff22;color:#3a8fff;border:1px solid #3a8fff66;padding:1px 5px;border-radius:2px;font-size:7px;font-weight:bold;letter-spacing:0.5px;">NEXT</span>'
      : (!isActive && queuePos===0)
        ? '<span style="background:#3a8fff11;color:#3a8fff88;border:1px solid #3a8fff33;padding:1px 5px;border-radius:2px;font-size:7px;letter-spacing:0.5px;">NEXT UP</span>'
        : '';

    const rowCls = 'pl-item' + (isSel?' selected':'') + (isNext?' pl-item-next':'');
    const dispNum = queuePos + 1; // always 1, 2, 3...

    return `<div class="${rowCls}" data-idx="${i}"
      draggable="true" ondragstart="onPlDragStart(event,${i})"
      ondragover="onPlDragOverItem(event,${i})"
      ondrop="onPlDropItem(event,${i})"
      onclick="plItemClick(${i})" ondblclick="plItemDblClick(${i})">
      <div class="pl-num">${dispNum}</div>
      <div class="pl-body">
        <div class="pl-meta">${statusBadge}${statusBadge?' &nbsp;':''} At: ${ts} &nbsp;|&nbsp; ${item.duration?fmtDur(item.duration):'—'}</div>
        <div class="pl-artist">${escHtml(item.artist||item.title)}</div>
        ${item.artist?`<div class="pl-title-small">${escHtml(item.title)}</div>`:''}
        <div class="pl-badges">
          ${tb}
          <span class="mixpt-badge mixpt-intro" onclick="event.stopPropagation();editMixPoint(${i},'intro')" title="Set intro cue">⏩ ${item.introSec!=null?fmtDur(item.introSec):'INTRO'}</span>
          <span class="mixpt-badge mixpt-outro" onclick="event.stopPropagation();editMixPoint(${i},'outro')" title="Set outro point">⏮ ${item.outroSec!=null?fmtDur(item.outroSec):'OUTRO'}</span>
          <button class="deck-load-btn deck-a-btn" onclick="event.stopPropagation();loadTrack(${i});showToast('Deck A: '+(STATE.playlist[${i}]?.artist||''))">→ A</button>
          <button class="deck-load-btn deck-b-btn" onclick="event.stopPropagation();loadDeckB(${i})">→ B</button>
        </div>
      </div></div>`;
  });

  // Ghost drop target — number is queue length + 1
  const ghostNum = queueItems.length + 1;
  const lastItem = STATE.playlist[STATE.playlist.length-1];
  let ghostTime;
  if(lastItem?.schedTime && lastItem?.duration){
    const t = new Date(lastItem.schedTime.getTime() + (lastItem.duration||0)*1000);
    ghostTime = t.toTimeString().slice(0,8);
  } else {
    ghostTime = new Date().toTimeString().slice(0,8);
  }
  const ghostSlot = `<div class="pl-ghost">
    <div class="pl-ghost-num">${ghostNum}</div>
    <div class="pl-ghost-body">
      <div class="pl-ghost-time">@ ${ghostTime}</div>
      <div class="pl-ghost-label">— drop or double-click to add —</div>
    </div>
  </div>`;

  c.innerHTML = rows.join('') + ghostSlot;
  updateNextEmptySlot();

  // Scroll queue to top so NEXT is always visible
  c.scrollTop = 0;
}

// ── Update the sticky Now-Playing card in the playlist panel ──
function updatePlNowStrip(){
  const strip = document.getElementById('plNowStrip'); if(!strip) return;
  const isActive = STATE.playing||STATE.paused;
  const item = STATE.playlist[STATE.nowPlayingIdx];

  if(!item || !isActive){
    strip.classList.remove('visible','paused');
    return;
  }
  strip.classList.add('visible');
  strip.classList.toggle('paused', STATE.paused && !STATE.playing);

  // Content
  const e = id => document.getElementById(id);
  if(e('plNowArtist')) e('plNowArtist').textContent = item.artist || item.title || '—';
  if(e('plNowTitle'))  e('plNowTitle').textContent  = item.artist ? (item.title||'') : '';
  if(e('plNowType'))   e('plNowType').textContent   = item.type==='youtube' ? 'YT'
    : (item.fileObj ? '.'+item.fileObj.name.split('.').pop().toUpperCase() : '');

  // Progress bar + time
  const pos = masterAudio?.currentTime || STATE.posSec || 0;
  const dur = masterAudio?.duration   || STATE.durSec || 0;
  const pct = dur>0 ? Math.min(100,(pos/dur)*100) : 0;
  if(e('plNowProgFill')) e('plNowProgFill').style.width = pct.toFixed(1)+'%';
  if(e('plNowPos'))      e('plNowPos').textContent = fmtDur(pos);
  if(e('plNowDur'))      e('plNowDur').textContent = dur>0 ? '-'+fmtDur(Math.max(0,dur-pos)) : '—';

  // Mix-point badges
  const badges = e('plNowBadges');
  if(badges){
    const introBadge = item.introSec!=null
      ? `<span class="mixpt-badge mixpt-intro" onclick="editMixPoint(${STATE.nowPlayingIdx},'intro')" title="Intro cue">⏩ ${fmtDur(item.introSec)}</span>` : '';
    const outroBadge = item.outroSec!=null
      ? `<span class="mixpt-badge mixpt-outro" onclick="editMixPoint(${STATE.nowPlayingIdx},'outro')" title="Outro point">⏮ ${fmtDur(item.outroSec)}</span>` : '';
    badges.innerHTML = introBadge + outroBadge;
  }

  // Next up
  const next = STATE.playlist[STATE.nowPlayingIdx+1];
  if(e('plNowNext')){
    e('plNowNext').innerHTML = next
      ? `▶ Next: <span>${escHtml(next.artist||next.title)}</span>`
      : '<span style="color:var(--text3)">End of playlist</span>';
  }
}

// Click on progress bar in now-playing strip to seek
function plNowSeek(e){
  const bar = document.getElementById('plNowProgTrack'); if(!bar) return;
  const r = bar.getBoundingClientRect();
  const frac = Math.max(0,Math.min(1,(e.clientX-r.left)/r.width));
  if(masterAudio && STATE.durSec) masterAudio.currentTime = frac * STATE.durSec;
}

// Add now-strip CSS for playing row


function plItemClick(idx){
  if(STATE.actionMode==='DELETE'){removeFromPlaylist(idx);return;}
  STATE.selectedPlIdx=idx; renderPlaylist();
  if(STATE.actionMode==='INSERT'){STATE.insertPos=idx+1;['insertPosInput','insertPosFile'].forEach(id=>{const e=document.getElementById(id);if(e)e.value=STATE.insertPos;});}
}
function plItemDblClick(idx){if(STATE.playlist[idx]?.fileObj){loadTrackAndPlay(idx,true);}}
function addToPlaylist(item){STATE.playlist.push(item);recalcPlaylistTimes();renderPlaylist();addLog('system',`Added: ${item.artist} – ${item.title}`,'—');}
function insertIntoPlaylist(item,pos){STATE.playlist.splice(Math.max(0,Math.min(STATE.playlist.length,pos-1)),0,item);recalcPlaylistTimes();renderPlaylist();}
function replaceInPlaylist(item,idx){if(idx<0||idx>=STATE.playlist.length)return;STATE.playlist[idx]=item;recalcPlaylistTimes();renderPlaylist();}
function removeFromPlaylist(idx){
  if(idx<0||idx>=STATE.playlist.length) return;
  STATE.playlist.splice(idx,1);
  if(STATE.nowPlayingIdx>=STATE.playlist.length) STATE.nowPlayingIdx=STATE.playlist.length-1;
  if(STATE.selectedPlIdx>=STATE.playlist.length) STATE.selectedPlIdx=-1;
  recalcPlaylistTimes(); renderPlaylist(); updateDeckDisplays();
}
function clearPlaylist(){STATE.playlist=[];STATE.nowPlayingIdx=-1;STATE.selectedPlIdx=-1;masterStop();renderPlaylist();updateNowPlayingDisplay();updateDeckDisplays();}
function plScrollTop(){document.getElementById('plList').scrollTop=0;}
function plScrollBottom(){const e=document.getElementById('plList');e.scrollTop=e.scrollHeight;}
function plMoveUp(){const i=STATE.selectedPlIdx;if(i<=0)return;[STATE.playlist[i-1],STATE.playlist[i]]=[STATE.playlist[i],STATE.playlist[i-1]];STATE.selectedPlIdx=i-1;if(STATE.nowPlayingIdx===i)STATE.nowPlayingIdx=i-1;else if(STATE.nowPlayingIdx===i-1)STATE.nowPlayingIdx=i;recalcPlaylistTimes();renderPlaylist();}
function plMoveDown(){const i=STATE.selectedPlIdx;if(i<0||i>=STATE.playlist.length-1)return;[STATE.playlist[i],STATE.playlist[i+1]]=[STATE.playlist[i+1],STATE.playlist[i]];STATE.selectedPlIdx=i+1;if(STATE.nowPlayingIdx===i)STATE.nowPlayingIdx=i+1;else if(STATE.nowPlayingIdx===i+1)STATE.nowPlayingIdx=i;recalcPlaylistTimes();renderPlaylist();}

function setActionMode(mode){
  if(mode==='CLEAR'){openModal('clearConfirmModal');return;}
  STATE.actionMode=mode;
  document.querySelectorAll('.act-btn[data-mode]').forEach(b=>b.classList.toggle('active',b.dataset.mode===mode));
  const mn=document.getElementById('modeNameDisplay'); if(mn) mn.textContent=mode;
  const colors={ADD:'var(--green)',INSERT:'var(--blue)',REPLACE:'var(--yellow)',DELETE:'var(--red)'};
  const dot=document.getElementById('modeDot'); if(dot) dot.style.background=colors[mode]||'var(--green)';
  const ib=document.getElementById('insertPosBarFile'); if(ib) ib.className='insert-pos-bar'+(mode==='INSERT'?' visible':'');
  const pb=document.getElementById('insertPosBar');     if(pb) pb.className='pl-mode-insert-pos'+(mode==='INSERT'?' visible':'');
}
function syncInsertPos(val){STATE.insertPos=parseInt(val)||1;['insertPosInput','insertPosFile'].forEach(id=>{const e=document.getElementById(id);if(e)e.value=STATE.insertPos;});}
function confirmClear(){clearPlaylist();closeModal('clearConfirmModal');}

// ─── FILE LIBRARY ─────────────────────────────────────
async function onFolderPicked(input){
  const files=Array.from(input.files).filter(f=>/\.(mp3|wav|flac|aac|ogg|m4a)$/i.test(f.name));
  if(!files.length){alert('No audio files found.');return;}
  const folderId='folder_'+Date.now();
  const folderName=files[0].webkitRelativePath.split('/')[0]||'Folder';
  STATE.folders.push({id:folderId,name:folderName,fileCount:files.length});
  addFolderToSelects(folderId,folderName);
  const newFiles=[];
  for(const file of files){
    const li={name:file.name,fileObj:file,duration:null,artist:'',title:'',bpm:null,genre:'',folderId};
    parseFilename(li); newFiles.push(li); STATE.fileLibrary.push(li);
  }
  STATE.activeFolderId=folderId;
  const ss=document.getElementById('sourceSelect'); if(ss) ss.value=folderId;
  renderFileList(); extractDurations(newFiles);
  addLog('system',`Folder: ${folderName} (${files.length} files)`,'—');
  input.value='';
}
function parseFilename(item){
  let name=item.name.replace(/\.[^/.]+$/,'');
  const sep=name.includes(' – ')?' – ':name.includes(' - ')?' - ':null;
  if(sep){const p=name.split(sep);item.artist=p[0].trim();item.title=p.slice(1).join(sep).trim();}
  else{item.artist='';item.title=name;}
}
async function extractDurations(items){
  for(const item of items){
    if(item.duration!==null) continue;
    await new Promise(resolve=>{
      const a=new Audio(),url=URL.createObjectURL(item.fileObj);
      a.src=url;
      a.addEventListener('loadedmetadata',()=>{item.duration=a.duration;URL.revokeObjectURL(url);resolve();});
      a.addEventListener('error',()=>{URL.revokeObjectURL(url);resolve();});
      a.load();
    });
  }
  loadTrackMeta();
  renderFileList(); recalcPlaylistTimes();
}
function addFolderToSelects(id,name){
  [document.getElementById('sourceSelect'),document.getElementById('randSource')].forEach(sel=>{
    if(!sel) return;
    const opt=document.createElement('option'); opt.value=id; opt.textContent=name; sel.appendChild(opt);
  });
}
function removeFolder(){
  const sel=document.getElementById('sourceSelect'); if(!sel) return;
  const fid=sel.value; if(!fid) return;
  STATE.fileLibrary=STATE.fileLibrary.filter(f=>f.folderId!==fid);
  STATE.folders=STATE.folders.filter(f=>f.id!==fid);
  sel.querySelector(`option[value="${fid}"]`)?.remove();
  document.querySelector(`#randSource option[value="${fid}"]`)?.remove();
  STATE.activeFolderId=null; renderFileList();
}
function onSourceChange(val){STATE.activeFolderId=val||null;renderFileList();}
function onGenreChange(val){STATE.genreFilter=val;renderFileList();}
function doSearch(q){STATE.searchQuery=q.toLowerCase();renderFileList();}
function searchAllFolders(){STATE.activeFolderId=null;const ss=document.getElementById('sourceSelect');if(ss)ss.value='';renderFileList();}
function resetSearch(){STATE.searchQuery='';STATE.genreFilter='';['searchInput','genreSelect'].forEach(id=>{const e=document.getElementById(id);if(e)e.value='';});renderFileList();}
function getFilteredLibrary(){
  return STATE.fileLibrary.filter(f=>{
    if(STATE.activeFolderId&&f.folderId!==STATE.activeFolderId) return false;
    if(STATE.genreFilter&&f.genre!==STATE.genreFilter) return false;
    if(STATE.searchQuery){const q=STATE.searchQuery;if(!f.name.toLowerCase().includes(q)&&!f.title.toLowerCase().includes(q)&&!f.artist.toLowerCase().includes(q)) return false;}
    return true;
  });
}
function renderFileList(){
  const el=document.getElementById('fileList'); if(!el) return;
  const files=getFilteredLibrary();
  if(!files.length){el.innerHTML=STATE.fileLibrary.length===0?'<div class="fi-loading">📂 No folder loaded. Use "+ Folder" below.</div>':'<div class="fi-loading">No files match search.</div>';return;}
  const np=STATE.playlist[STATE.nowPlayingIdx]?.fileObj;
  el.innerHTML=files.map((f,i)=>{
    const ip=np&&f.fileObj===np;
    return `<div class="fi ${ip?'now-playing':''}" onclick="fileClick(${i})" ondblclick="fileDblClick(${i})">
      <div class="fi-icon">${ip?'▶':'♪'}</div>
      <div class="fi-info">
        ${f.artist?`<div class="fi-name ${ip?'now-playing-name':''}">${escHtml(f.artist)}</div><div class="fi-name" style="color:var(--text2);font-size:9px;">${escHtml(f.title)}</div>`:
        `<div class="fi-name ${ip?'now-playing-name':''}">${escHtml(f.title)}</div>`}
      </div>
      <div class="fi-dur">${f.duration?fmtDur(f.duration):'...'}</div></div>`;
  }).join('');
}
function fileClick(idx){document.querySelectorAll('.fi').forEach((el,i)=>el.classList.toggle('sel',i===idx));}
function fileDblClick(idx){
  const f=getFilteredLibrary()[idx]; if(!f) return;
  const item={id:'pl_'+Date.now()+'_'+Math.random(),artist:f.artist,title:f.title||f.name,duration:f.duration,fileObj:f.fileObj,type:'file',bpm:f.bpm,genre:f.genre,url:null};
  switch(STATE.actionMode){
    case 'ADD':     addToPlaylist(item); break;
    case 'INSERT':  insertIntoPlaylist(item,STATE.insertPos); break;
    case 'REPLACE': replaceInPlaylist(item,STATE.selectedPlIdx); break;
  }
}
function openFolderPicker(){document.getElementById('folderPicker').click();}

// YouTube
// Two panel views in the file area: FILE and BROWSER
// Clicking either always switches to that view regardless of current state.
function showFilePanel(){
  const yt  = document.getElementById('ytBrowserView');
  const fl  = document.getElementById('fileList');
  const sb  = document.querySelector('.search-box');
  const ftab= document.getElementById('fileViewTab');
  const btab= document.getElementById('browserTab');
  if(yt)  yt.classList.remove('visible');
  if(fl)  fl.style.display = '';
  if(sb)  sb.style.display = '';
  if(ftab){ ftab.classList.remove('view-inactive'); ftab.classList.add('active'); }
  if(btab)  btab.classList.remove('active');
}
function showBrowserPanel(){
  const yt  = document.getElementById('ytBrowserView');
  const fl  = document.getElementById('fileList');
  const sb  = document.querySelector('.search-box');
  const ftab= document.getElementById('fileViewTab');
  const btab= document.getElementById('browserTab');
  if(yt)  yt.classList.add('visible');
  if(fl)  fl.style.display = 'none';
  if(sb)  sb.style.display = 'none';
  if(ftab){ ftab.classList.add('view-inactive'); ftab.classList.remove('active'); }
  if(btab)  btab.classList.add('active');
  brSwitchTab(brCurrentTab||'dir');
  brRenderStations();
}
// Keep old name working for any internal callers
function toggleBrowserTab(){ showBrowserPanel(); }
// ─── BROWSER PANEL ─────────────────────────────────────
const BR_STATIONS=[
  // Embeddable streams/iframes — curated to avoid X-Frame-Options blocks
  {name:'Radio Garden',   url:'https://radio.garden/listen',          desc:'Interactive globe of live radio stations worldwide',           genre:'Directory'},
  {name:'SomaFM – Groove Salad', url:'https://somafm.com/groovesalad/', desc:'A nicely chilled plate of ambient/downtempo beats',           genre:'Ambient'},
  {name:'SomaFM – Indie Pop',    url:'https://somafm.com/indiepop/',    desc:'New and classic indie pop tracks',                            genre:'Indie'},
  {name:'SomaFM – SF Police Scanner', url:'https://somafm.com/scanner/', desc:'Live SF police/fire/medical scanner',                        genre:'Live'},
  {name:'DI.FM – Chillout',  url:'https://www.di.fm/chillout',        desc:'Premium electronic radio – chillout channel',                  genre:'Chill'},
  {name:'Internet Archive – Audio', url:'https://archive.org/details/audio', desc:'Free public domain & CC-licensed audio',                genre:'Archive'},
  {name:'Bandcamp – New + Notable', url:'https://bandcamp.com/',        desc:'Discover & stream independent music from artists worldwide',   genre:'Indie'},
  {name:'YouTube Music',     url:'https://music.youtube.com',          desc:'YouTube Music — streams may block iframe; opens in frame',      genre:'Music'},
  {name:'Mixcloud – Charts', url:'https://www.mixcloud.com/charts/hot/', desc:'Trending DJ mixes and radio shows',                         genre:'DJ/Mix'},
  {name:'NPR Music',         url:'https://www.npr.org/music/',         desc:'NPR live streams and music coverage',                          genre:'Public'},
  {name:'BBC Sounds',        url:'https://www.bbc.co.uk/sounds',       desc:'BBC live radio, podcasts, and music — may block iframe',       genre:'Public'},
  {name:'Shoutcast Directory', url:'https://directory.shoutcast.com/', desc:'Thousands of independent internet radio stations',             genre:'Directory'},
  {name:'TuneIn Radio',      url:'https://tunein.com/',                desc:'Live radio stations, sports, news and podcasts',               genre:'Directory'},
];

let brCurrentTab='dir';
let brHistory=[];

function brRenderStations(){
  const grid=document.getElementById('brStationsGrid'); if(!grid) return;
  grid.innerHTML=BR_STATIONS.map((s,i)=>`
    <div class="br-station-card" onclick="brOpenStation('${escHtml(s.url)}','${escHtml(s.name)}')">
      <div class="br-st-name">${escHtml(s.name)}</div>
      <div class="br-st-desc">${escHtml(s.desc)}</div>
      <div class="br-st-genre">${escHtml(s.genre)}</div>
    </div>`).join('');
}

function brOpenStation(url, name){
  // Sites known to allow iframe embedding
  const embeddable=['radio.garden','somafm.com','archive.org','bandcamp.com','di.fm'];
  const canEmbed=embeddable.some(d=>url.includes(d));
  if(canEmbed){
    brLoadFrame(url, name);
  } else {
    // Open in new tab + show friendly placeholder
    window.open(url,'_blank','noopener');
    const n=document.getElementById('brNotice');
    if(n) n.textContent='↗ '+name+' opened in new tab (site blocks iframe embedding)';
    // Show a helpful placeholder in the frame area
    const frame=document.getElementById('brFrame');
    const wrap=document.getElementById('ytFrameWrap');
    if(wrap) wrap.style.display='';
    if(frame) frame.src='about:blank';
    const fn=document.getElementById('brFrameNotice');
    if(fn) fn.textContent=name+' was opened in a new tab — this site blocks embedding.';
  }
  brSwitchTab('url');
  const inp=document.getElementById('ytUrlInput'); if(inp) inp.value=url;
}

// brSwitchTab is defined later in the new features block

function brNavigate(){
  const inp=document.getElementById('ytUrlInput'); if(!inp) return;
  let url=inp.value.trim(); if(!url) return;
  const notice=document.getElementById('brNotice');

  // ── YouTube VIDEO → embed with youtube-nocookie (no X-Frame-Options block) ──
  const ytMatch=url.match(/(?:v=|youtu\.be\/|embed\/)([a-zA-Z0-9_-]{11})/);
  if(ytMatch){
    const vid=ytMatch[1];
    const embed=`https://www.youtube-nocookie.com/embed/${vid}?autoplay=1&rel=0&modestbranding=1`;
    brLoadFrame(embed,'▶ YouTube: '+vid);
    // Store for addYTToPlaylist
    window._currentYTId=vid;
    window._currentYTTitle='YouTube: '+vid;
    window._currentYTChannel='YouTube';
    const addBtn=document.getElementById('brAddBtn');
    if(addBtn){addBtn.style.display='';addBtn.textContent='+ Add to Playlist';}
    if(notice) notice.textContent='▶ Playing YouTube: '+vid+' — click "+ Add to Playlist" to queue it';
    brHistory.push(embed);
    return;
  }

  // ── youtube.com homepage or typed "youtube" → open new tab ──
  if(url.includes('youtube.com')||url.toLowerCase().trim()==='youtube'){
    window.open('https://www.youtube.com','_blank','noopener');
    if(notice) notice.textContent='↗ YouTube opened in new tab';
    return;
  }

  // ── Plain text (no http) → YouTube search in new tab ──
  if(!url.startsWith('http')){
    window.open('https://www.youtube.com/results?search_query='+encodeURIComponent(url),'_blank','noopener');
    if(notice) notice.textContent='↗ YouTube search: "'+url+'"';
    return;
  }

  // ── Normal URL → load in iframe ──
  if(!url.startsWith('http')) url='https://'+url;
  inp.value=url;
  brLoadFrame(url,url);
  brHistory.push(url);
}

function brLoadFrame(url, notice){
  const wrap=document.getElementById('ytFrameWrap'); if(!wrap) return;
  if(wrap.style.display==='none') wrap.style.display='';
  const frame=document.getElementById('brFrame'); if(!frame) return;
  frame.src=url;
  const n=document.getElementById('brFrameNotice'); if(n) n.textContent=notice||'';
  const bn=document.getElementById('brNotice'); if(bn) bn.textContent=url.substring(0,60)+(url.length>60?'…':'');
}

function brNavBack(){
  if(brHistory.length>1){brHistory.pop();brLoadFrame(brHistory[brHistory.length-1],'');}
}
function brNavRefresh(){
  const frame=document.getElementById('brFrame'); if(frame) frame.src=frame.src;
}

function loadYT(){
  brSwitchTab('yt');
  brNavigate();
}

function addYTToPlaylist(){
  // Use the stored current video info (set when video was loaded)
  const videoId=window._currentYTId;
  const title=window._currentYTTitle||document.getElementById('ytUrlInput')?.value.trim()||'YouTube Video';
  const channel=window._currentYTChannel||'YouTube';
  if(!videoId && !document.getElementById('ytUrlInput')?.value.trim()){
    showToast('No YouTube video loaded');return;
  }
  if(videoId){
    addToPlaylist({
      id:'pl_yt_'+Date.now(),
      artist:channel,
      title:title,
      duration:null,
      fileObj:null,
      type:'youtube',
      url:'https://www.youtube.com/watch?v='+videoId,
      bpm:null,genre:'',
      ytId:videoId
    });
  } else {
    // Fallback: use raw URL from input
    const url=document.getElementById('ytUrlInput').value.trim();
    addToPlaylist({id:'pl_yt_'+Date.now(),artist:'YouTube',title:url,duration:null,fileObj:null,type:'youtube',url,bpm:null,genre:''});
  }
  showToast('✓ Added to playlist: '+title.substring(0,50));
}

// Transport
function doRestart(){
  if(masterAudio){
    masterAudio.currentTime=0;
    STATE.posSec=0;
    updateTimingDisplay();
    updateNowPlayingDisplay();
    renderPlaylist();
    // Redraw wavestrip from scratch for the current item
    const item=STATE.playlist[STATE.nowPlayingIdx];
    const wsA=document.getElementById('waveStripA');
    if(wsA && item) drawWaveStrip('A', item);
    addLog('system','Restarted: '+getCurrentTrackTitle(),'—');
  }
}
function doSkipNext(){
  const ni=STATE.nowPlayingIdx+1;
  if(ni<STATE.playlist.length){
    loadTrackAndPlay(ni, true); // always autoplay on skip
  } else {
    showToast('End of playlist');
  }
}
function doToggleLoop(){STATE.loopMode=!STATE.loopMode;const b=document.getElementById('btnLoop');if(b){b.classList.toggle('active',STATE.loopMode);b.textContent=STATE.loopMode?'⇄ LOOP ON':'⇄ LOOP';}}
function toggleAutoplay(){STATE.autoplay=!STATE.autoplay;const b=document.getElementById('bbAutoplay');if(b){b.classList.toggle('on',STATE.autoplay);b.textContent=STATE.autoplay?'▶ Autoplay ON':'▶ Autoplay';}}

// ─── ASSIST / AUTOMATION MODE ─────────────────────────
// Automation mode: playlist advances automatically, loads next on deck A end.
// Live Assist mode: automation PAUSES after each track. DJ manually hits play.
function toggleAssistMode(){
  STATE.assistMode=!STATE.assistMode;
  const btn=document.getElementById('bbAssistBtn');
  if(btn){
    btn.classList.toggle('assist-on', STATE.assistMode);
    btn.textContent=STATE.assistMode?'🎧 LIVE ASSIST':'🎧 Assist';
  }
  // In assist mode, autoplay continues but pauses at track end waiting for DJ
  addLog('system', STATE.assistMode?'Switched to LIVE ASSIST mode':'Switched to AUTOMATION mode','—');
  showToast(STATE.assistMode?'Live Assist ON — you control each transition':'Automation ON');
}
function doExit(){if(confirm('Exit BroadcastPro FM?'))window.close();}

const progTrack=document.getElementById('progTrack');
if(progTrack) progTrack.addEventListener('click',function(e){
  if(!masterAudio||!STATE.durSec) return;
  const r=this.getBoundingClientRect();
  masterAudio.currentTime=((e.clientX-r.left)/r.width)*STATE.durSec;
});

// ─── AUDIO CONTEXT KEEP-ALIVE ─────────────────────────
// Browsers suspend AudioContext when the tab loses focus.
document.addEventListener('visibilitychange', () => {
  if(document.visibilityState==='visible' && audioCtx && audioCtx.state==='suspended')
    audioCtx.resume().catch(()=>{});
});
document.addEventListener('click', () => {
  if(audioCtx && audioCtx.state==='suspended') audioCtx.resume().catch(()=>{});
}, {passive:true});

// ─── CLOCK ────────────────────────────────────────────
function updateClock(){
  const now=new Date();
  const cl=document.getElementById('clockDig'); if(cl) cl.textContent=now.toTimeString().slice(0,8);
  const days=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const cd=document.getElementById('clockDate'); if(cd) cd.textContent=`${days[now.getDay()]} ${String(now.getDate()).padStart(2,'0')}-${months[now.getMonth()]}-${String(now.getFullYear()).slice(2)}`;
}
setInterval(updateClock,1000); updateClock();

// ─── VU METERS ────────────────────────────────────────
let vuPeakL=0,vuPeakR=0,vuHoldL=0,vuHoldR=0,vuTimerL=0,vuTimerR=0;

function animateVU(){
  requestAnimationFrame(animateVU);
  let lv=0;
  if(masterAnalyser&&STATE.playing){masterAnalyser.getByteFrequencyData(masterAnalyserData);lv=masterAnalyserData.reduce((a,b)=>a+b,0)/masterAnalyserData.length;}
  const lP=STATE.playing?Math.min(97,(lv/128)*100+Math.random()*3):Math.max(0,vuPeakL-3);
  const rP=STATE.playing?Math.min(97,(lv/128)*100-1+Math.random()*3):Math.max(0,vuPeakR-3);
  vuPeakL=lP; vuPeakR=rP;
  if(lP>vuHoldL){vuHoldL=lP;vuTimerL=55;} if(rP>vuHoldR){vuHoldR=rP;vuTimerR=55;}
  if(--vuTimerL<=0) vuHoldL=Math.max(0,vuHoldL-0.7);
  if(--vuTimerR<=0) vuHoldR=Math.max(0,vuHoldR-0.7);
  const s=id=>document.getElementById(id);
  if(s('vuL'))  s('vuL').style.width=lP+'%';
  if(s('vuR'))  s('vuR').style.width=rP+'%';
  if(s('vuPeakL')) s('vuPeakL').style.left=vuHoldL+'%';
  if(s('vuPeakR')) s('vuPeakR').style.left=vuHoldR+'%';
  if(s('djVuL'))   s('djVuL').style.width=lP+'%';
  if(s('djVuR'))   s('djVuR').style.width=rP+'%';
  if(s('vuPeakIndL')) s('vuPeakIndL').style.left=vuHoldL+'%';
  if(s('vuPeakIndR')) s('vuPeakIndR').style.left=vuHoldR+'%';
  if(s('deckVuAL')) s('deckVuAL').style.height=lP+'%';
  if(s('deckVuAR')) s('deckVuAR').style.height=rP+'%';
  // Deck B — use its own analyser if available, otherwise decay to 0
  let bVuL=0, bVuR=0;
  if(deckBAnalyser && deckState.B.playing && deckBAudio && !deckBAudio.paused){
    deckBAnalyser.getByteFrequencyData(deckBAnalyserData);
    const bLv = deckBAnalyserData.reduce((a,b)=>a+b,0)/deckBAnalyserData.length;
    bVuL = Math.min(97,(bLv/128)*100 + Math.random()*2);
    bVuR = Math.min(97,(bLv/128)*100 - 1 + Math.random()*2);
  } else {
    bVuL = Math.max(0, parseFloat(s('deckVuBL')?.style.height||'0') - 4);
    bVuR = Math.max(0, parseFloat(s('deckVuBR')?.style.height||'0') - 4);
  }
  if(s('deckVuBL')) s('deckVuBL').style.height = bVuL+'%';
  if(s('deckVuBR')) s('deckVuBR').style.height = bVuR+'%';
}

// ─── CENTER CHANNEL FADERS ────────────────────────────
const faderState={music:80,sampler:75,mic:85,duck:50};

// Shared mic gain node for volume control
let micGainNode=null;

function updateFaderUI(ch,pct){
  const ff=document.getElementById('ff-'+ch);
  const fh=document.getElementById('fh-'+ch);
  const fv=document.getElementById('fv-'+ch);
  if(ff) ff.style.height=pct+'%';
  if(fh) fh.style.bottom='calc('+pct+'% - 5px)';
  if(fv) fv.textContent=pct+'%';
  const t=audioCtx?.currentTime||0;
  if(ch==='music'&&masterGain&&audioCtx){
    // Only apply if not ducking — ducking has its own gain target
    if(!micActive) masterGain.gain.setTargetAtTime(pct/100,t,0.02);
  }
  if(ch==='sampler'){
    // Live-update any currently playing sweeper pad
    const key=STATE.activeBankIdx+'_'+STATE.playingPadIdx;
    if(STATE.playingPadIdx>=0&&swAudioPool[key]){
      const bank=STATE.swBanks[STATE.activeBankIdx];
      const pad=bank?.pads[STATE.playingPadIdx];
      swAudioPool[key].volume=Math.min(1,(pad?.volume||100)/100*(pct/100));
    }
  }
  if(ch==='mic'&&micGainNode&&audioCtx){
    micGainNode.gain.setTargetAtTime(pct/100,t,0.02);
  }
  if(ch==='duck'){
    const e=document.getElementById('duckValDisplay');
    if(e) e.textContent=pct+'%';
    // Re-apply ducking if currently active
    if(micActive&&masterGain&&audioCtx){
      masterGain.gain.setTargetAtTime((faderState.music/100)*(1-pct/100),t,0.02);
    }
  }
}
['music','sampler','mic','duck'].forEach(ch=>{
  const track=document.getElementById('ft-'+ch); if(!track) return;
  let drag=false;
  track.addEventListener('mousedown',e=>{drag=true;moveFader(ch,e,track);e.preventDefault();});
  document.addEventListener('mousemove',e=>{if(drag)moveFader(ch,e,track);});
  document.addEventListener('mouseup',()=>{drag=false;});
});
function moveFader(ch,e,track){
  const r=track.getBoundingClientRect();
  let p=Math.round(100-((e.clientY-r.top)/r.height)*100);
  p=Math.max(0,Math.min(100,p));
  faderState[ch]=p; updateFaderUI(ch,p);
}
Object.entries(faderState).forEach(([ch,v])=>updateFaderUI(ch,v));

// ─── DECK CHANNEL FADERS (A & B) ──────────────────────
const deckFaderState={A:80,B:80};

function initDeckFaders(){
  ['A','B'].forEach(dk=>{
    const track=document.getElementById('chFt'+dk); if(!track) return;
    let drag=false;
    const move=e=>{
      if(!drag) return;
      const r=track.getBoundingClientRect();
      let p=Math.round(100-((e.clientY-r.top)/r.height)*100);
      p=Math.max(0,Math.min(100,p));
      deckFaderState[dk]=p; updateDeckFaderUI(dk,p);
    };
    track.addEventListener('mousedown',e=>{drag=true;move(e);e.preventDefault();});
    document.addEventListener('mousemove',move);
    document.addEventListener('mouseup',()=>{drag=false;});
    updateDeckFaderUI(dk,deckFaderState[dk]);
  });
}
function updateDeckFaderUI(dk,pct){
  const ff=document.getElementById('chFf'+dk),fh=document.getElementById('chFh'+dk),fv=document.getElementById('chFv'+dk);
  if(ff) ff.style.height=pct+'%';
  if(fh) fh.style.bottom='calc('+pct+'% - 5px)';
  if(fv) fv.textContent=pct+'%';
  if(dk==='A'&&gainNodeA&&audioCtx) gainNodeA.gain.setTargetAtTime(pct/100,audioCtx.currentTime,0.02);
  if(dk==='B'&&deckBGain&&audioCtx) deckBGain.gain.setTargetAtTime(pct/100,audioCtx.currentTime,0.02);
}

// ─── MIC + DUCKING ────────────────────────────────────
async function initMic(){
  try{
    micStream=await navigator.mediaDevices.getUserMedia({audio:true});
    initAudioCtx();
    const src=audioCtx.createMediaStreamSource(micStream);
    micAnalyser=audioCtx.createAnalyser(); micAnalyser.fftSize=256;
    // Mic gain node for fader control
    micGainNode=audioCtx.createGain();
    micGainNode.gain.value=faderState.mic/100;
    src.connect(micAnalyser);
    src.connect(micGainNode);
    // Mic audio goes directly to destination (not through master music chain)
    micGainNode.connect(audioCtx.destination);
    micData=new Uint8Array(micAnalyser.frequencyBinCount);
    monitorMic();
  }catch(e){const ml=document.getElementById('micStatusLbl');if(ml)ml.textContent='MIC N/A';}
}
let micPeakHold = 0, micPeakTimer = 0, micPeakHoldVal = 0;

function monitorMic(){
  if(!micAnalyser) return;
  micAnalyser.getByteFrequencyData(micData);
  const sens = parseInt(document.getElementById('micSensSlider')?.value || 40);

  // RMS for smooth level meter
  let sum = 0;
  for(let i=0; i<micData.length; i++) sum += micData[i]*micData[i];
  const rmsRaw = Math.sqrt(sum / micData.length);
  const norm   = Math.min(100, (rmsRaw / 128) * 100);

  // Peak hold
  if(norm > micPeakHoldVal){
    micPeakHoldVal = norm;
    clearTimeout(micPeakTimer);
    micPeakTimer = setTimeout(()=>{
      micPeakHoldVal = 0;
      const pk = document.getElementById('micLevelPeak');
      if(pk) pk.style.left = '0%';
    }, 1500);
  }

  // dB display (approx): 0% = -∞, 100% = 0dB
  const db = norm > 0.5 ? (20 * Math.log10(norm/100)).toFixed(1) : '-∞';

  const ml  = document.getElementById('micLevelFill');
  const pk  = document.getElementById('micLevelPeak');
  const pv  = document.getElementById('micPeakVal');
  if(ml) ml.style.width = norm.toFixed(1) + '%';
  if(pk) pk.style.left  = micPeakHoldVal.toFixed(1) + '%';
  if(pv) pv.textContent = db + ' dB';

  // Update threshold line position from sensitivity slider
  const threshPct = Math.max(5, Math.min(95, 100 - sens)); // invert: higher sens = lower threshold line
  const tl = document.getElementById('micThreshLine');
  if(tl) tl.style.left = threshPct + '%';

  // Talkover trigger
  if(norm > (100 - sens)){
    if(!micActive) activateDucking();
    if(duckTimeout) clearTimeout(duckTimeout);
    duckTimeout = setTimeout(deactivateDucking, releaseMs);
  }

  requestAnimationFrame(monitorMic);
}
function activateDucking(){
  if(micActive||duckLocked) return; micActive=true;
  document.getElementById('micIndicator')?.classList.add('ducking');
  const ml=document.getElementById('micStatusLbl'); if(ml) ml.textContent='ON AIR';
  const ds=document.getElementById('duckStatus'); if(ds){ds.className='duck-status active';ds.textContent='● ACTIVE — ducked';}
  if(masterGain&&audioCtx) masterGain.gain.setTargetAtTime((faderState.music/100)*(1-faderState.duck/100),audioCtx.currentTime,attackMs/1000);
  addLog('system','MIC TALKOVER START','—');
}
function deactivateDucking(){
  if(!micActive) return; micActive=false;
  document.getElementById('micIndicator')?.classList.remove('ducking');
  const ml=document.getElementById('micStatusLbl'); if(ml) ml.textContent='MIC IDLE';
  const ds=document.getElementById('duckStatus'); if(ds){ds.className='duck-status idle';ds.textContent='● IDLE';}
  if(masterGain&&audioCtx) masterGain.gain.setTargetAtTime(faderState.music/100,audioCtx.currentTime,releaseMs/1000);
}
function adjustDuck(d){if(duckLocked)return;faderState.duck=Math.max(0,Math.min(100,faderState.duck+d));updateFaderUI('duck',faderState.duck);}
function adjustAttack(d){if(duckLocked)return;attackMs=Math.max(50,Math.min(2000,attackMs+d));const e=document.getElementById('attackVal');if(e)e.textContent=attackMs+'ms';}
function adjustRelease(d){if(duckLocked)return;releaseMs=Math.max(100,Math.min(5000,releaseMs+d));const e=document.getElementById('releaseVal');if(e)e.textContent=releaseMs+'ms';}
function toggleDuckLock(){duckLocked=!duckLocked;const b=document.getElementById('duckLockBtn');if(b){b.classList.toggle('locked',duckLocked);b.textContent=duckLocked?'🔒 Locked':'🔓 Click to Lock';}}

// Manual mic toggle — click the mic icon to force talkover on/off
let micManualOn=false;
function toggleMicManual(){
  micManualOn=!micManualOn;
  const ind=document.getElementById('micIndicator');
  const lbl=document.getElementById('micStatusLbl');
  if(micManualOn){
    activateDucking();
    if(ind) ind.style.boxShadow='0 0 18px rgba(255,64,64,0.9)';
    if(lbl) lbl.textContent='ON AIR';
  } else {
    deactivateDucking();
    if(ind) ind.style.boxShadow='';
    if(lbl) lbl.textContent='MIC IDLE';
  }
  if(ind) ind.title=micManualOn?'Mic is ON — click to turn off':'Click to toggle mic on/off';
}

// ─── PRO ROTARY KNOBS ─────────────────────────────────
let activeKnob=null,knobStartY=0,knobStartVal=0;

function initKnobs(){
  document.querySelectorAll('.rknob').forEach(knob=>{
    knob.addEventListener('mousedown',e=>{
      activeKnob=knob; knobStartY=e.clientY;
      knobStartVal=parseFloat(knob.dataset.val||0);
      e.preventDefault();
    });
    knob.addEventListener('dblclick',()=>resetKnob(knob));
  });
}
document.addEventListener('mousemove',e=>{
  if(!activeKnob) return;
  const dy=knobStartY-e.clientY;
  const min=parseFloat(activeKnob.dataset.min??0);
  const max=parseFloat(activeKnob.dataset.max??100);
  const speed=(max-min)<=20?0.12:0.55;
  const nv=Math.max(min,Math.min(max,knobStartVal+dy*speed));
  activeKnob.dataset.val=nv;
  updateKnobVisual(activeKnob,nv,min,max);
  applyKnobEffect(activeKnob.id,nv,min,max);
});
document.addEventListener('mouseup',()=>{activeKnob=null;});

function updateKnobVisual(knob,val,min,max){
  const ind=knob.querySelector('.rknob-indicator'); if(!ind) return;
  const pct=(val-min)/(max-min);
  const deg=-135+pct*270;
  const size=knob.classList.contains('sz-lg')?34:knob.classList.contains('sz-md')?28:24;
  const topPx=parseInt(ind.style.top||4);
  ind.style.transformOrigin=`50% ${size/2-topPx}px`;
  ind.style.transform=`translateX(-50%) rotate(${deg}deg)`;
  const valEl=document.getElementById(knob.id+'_val');
  if(valEl){
    const isEq=!!knob.id.match(/^eq[AB]/);
    const isFilter=knob.classList.contains('filter')&&!knob.id.startsWith('fx');
    if(isEq) valEl.textContent=(val>0?'+':'')+val.toFixed(1);
    else if(isFilter) valEl.textContent=(val-50).toFixed(0);
    else valEl.textContent=Math.round(val);
  }
}
function resetKnob(knob){
  const min=parseFloat(knob.dataset.min??0),max=parseFloat(knob.dataset.max??100);
  const isFilter=knob.classList.contains('filter')&&!knob.id.startsWith('fx');
  const rv=isFilter?50:knob.id.match(/^eq/)?0:75;
  knob.dataset.val=rv; updateKnobVisual(knob,rv,min,max); applyKnobEffect(knob.id,rv,min,max);
}
function applyKnobEffect(id,val){
  const ctx=audioCtx?.currentTime||0;
  if(id==='eqA_hi'  &&eqAHi)   eqAHi.gain.setTargetAtTime(val,ctx,0.01);
  if(id==='eqA_mid' &&eqAMid)  eqAMid.gain.setTargetAtTime(val,ctx,0.01);
  if(id==='eqA_lo'  &&eqALo)   eqALo.gain.setTargetAtTime(val,ctx,0.01);
  if(id==='gainA'   &&gainNodeA) gainNodeA.gain.setTargetAtTime(val/100,ctx,0.01);
  if(id==='eqB_hi'  &&deckBEqHi)  deckBEqHi.gain.setTargetAtTime(val,ctx,0.01);
  if(id==='eqB_mid' &&deckBEqMid) deckBEqMid.gain.setTargetAtTime(val,ctx,0.01);
  if(id==='eqB_lo'  &&deckBEqLo)  deckBEqLo.gain.setTargetAtTime(val,ctx,0.01);
  if(id==='gainB'   &&deckBGain)  deckBGain.gain.setTargetAtTime(val/100,ctx,0.01);
  if(id==='filterA') applyFilter('A',val);
  if(id==='filterB') applyFilter('B',val);
  if(id.match(/^fx(Wet|P1|P2)[AB]$/)) applyFXParam(id,val);
}
function initKnobVisuals(){
  document.querySelectorAll('.rknob').forEach(knob=>{
    const min=parseFloat(knob.dataset.min??0),max=parseFloat(knob.dataset.max??100);
    updateKnobVisual(knob,parseFloat(knob.dataset.val??0),min,max);
  });
}

// ─── FILTER ───────────────────────────────────────────
function applyFilter(deck,val){
  if(!audioCtx||deck!=='A') return;
  if(!filterNodeA){
    filterNodeA=audioCtx.createBiquadFilter();
    filterNodeA.Q.value=1.2;
    if(gainNodeA&&masterGain){try{gainNodeA.disconnect(masterGain);}catch(e){}gainNodeA.connect(filterNodeA);filterNodeA.connect(masterGain);}
  }
  if(val===50){filterNodeA.type='allpass';}
  else if(val<50){filterNodeA.type='lowpass';filterNodeA.frequency.setTargetAtTime(200+(val/50)*19800,audioCtx.currentTime,0.02);}
  else{filterNodeA.type='highpass';filterNodeA.frequency.setTargetAtTime(20+((val-50)/50)*4000,audioCtx.currentTime,0.02);}
}

// ─── TEMPO SLIDER ─────────────────────────────────────
const tempoState={A:0,B:0};

function setTempo(deck,val){
  val=parseFloat(val); tempoState[deck]=val;
  const d=document.getElementById('tempoVal'+deck);
  if(d) d.textContent=(val>=0?'+':'')+val.toFixed(1)+'%';
  if(deck==='A'&&masterAudio) masterAudio.playbackRate=1+val/100;
  if(deck==='B'&&deckBAudio) deckBAudio.playbackRate=1+val/100;
  const rpmEl=document.getElementById('platterRpm'+deck);
  if(rpmEl){const spin=deck==='A'?STATE.playing:platters.B.spinning;rpmEl.textContent=(33.3*(1+val/100)).toFixed(1)+' RPM · '+(spin?'PLAY':'STOP');}
}
function resetTempo(deck){
  tempoState[deck]=0;
  const sl=document.getElementById('tempo'+deck); if(sl) sl.value=0;
  const d=document.getElementById('tempoVal'+deck); if(d) d.textContent='±0.0%';
  if(deck==='A'&&masterAudio) masterAudio.playbackRate=1;
  if(deck==='B'&&deckBAudio)  deckBAudio.playbackRate=1;
  const rpmEl=document.getElementById('platterRpm'+deck);
  if(rpmEl){const spin=deck==='A'?STATE.playing:platters.B.spinning;rpmEl.textContent='33.3 RPM · '+(spin?'PLAY':'STOP');}
  showToast('Deck '+deck+' tempo reset to 0%');
}
function setLoopIn(deck){
  const pos=deck==='A'&&masterAudio?masterAudio.currentTime:0;
  loopState[deck]={inPoint:pos,outPoint:null,active:false,bars:null};
  document.getElementById('loopIn'+deck)?.classList.add('set');
  document.getElementById('loopOut'+deck)?.classList.remove('set','active');
  addLog('system',`Deck ${deck} LOOP IN @ ${fmtDur(pos)}`,'—');
}
function setLoopOut(deck){
  if(loopState[deck].inPoint===null) return;
  const pos=deck==='A'&&masterAudio?masterAudio.currentTime:loopState[deck].inPoint+4;
  loopState[deck].outPoint=pos; loopState[deck].active=true;
  document.getElementById('loopOut'+deck)?.classList.add('set','active');
  addLog('system',`Deck ${deck} LOOP OUT @ ${fmtDur(pos)}`,'—');
}
function quickLoop(deck,bars){
  [1,2,4,8].forEach(b=>document.getElementById('loop'+b+deck)?.classList.remove('active'));
  const btn=document.getElementById('loop'+bars+deck);
  if(loopState[deck].bars===bars&&loopState[deck].active){
    loopState[deck].active=false; loopState[deck].bars=null;
    if(btn) btn.classList.remove('active'); return;
  }
  const item=deck==='A'?STATE.playlist[STATE.nowPlayingIdx]:STATE.playlist[STATE.nowPlayingIdx+1];
  const bpm=item?.bpm||120;
  const loopLen=(60/bpm)*4*bars;
  const pos=deck==='A'&&masterAudio?masterAudio.currentTime:0;
  loopState[deck]={inPoint:pos,outPoint:pos+loopLen,active:true,bars};
  if(btn) btn.classList.add('active');
  addLog('system',`Deck ${deck} LOOP ${bars} bars`,'—');
}

// ─── PERFORMANCE PADS ─────────────────────────────────
const perfMode={A:'hot',B:'hot'};
const hotCues={A:[null,null,null,null],B:[null,null,null,null]};
const PAD_COLORS={hot:['#ff4040','#ff6030','#ff3060','#ff3090'],roll:['#00aadd','#0088cc','#00bbee','#006699'],slicer:['#9b59b6','#8e44ad','#aa66cc','#7d3f98'],saved:['#00cc50','#00aa40','#00dd60','#009930']};

function setPerfMode(deck,mode){
  perfMode[deck]=mode;
  ['hot','roll','slicer','saved'].forEach(m=>document.getElementById('pm'+deck+'_'+m)?.classList.toggle('on',m===mode));
  renderPerfPads(deck);
}
function renderPerfPads(deck){
  const mode=perfMode[deck],colors=PAD_COLORS[mode];
  const labels={hot:['H1','H2','H3','H4'],roll:['1/8','1/4','1/2','1'],slicer:['SL1','SL2','SL3','SL4'],saved:['S1','S2','S3','S4']}[mode];
  const container=document.getElementById('perfPads'+deck); if(!container) return;
  container.innerHTML=labels.map((lbl,i)=>{
    const cueSet=mode==='hot'&&hotCues[deck][i]!==null;
    const c=colors[i];
    return `<div class="pp pp-${mode}${cueSet?' lit':''}" style="background:${c}22;border-color:${c}66;color:${c};"
      onclick="triggerPad('${deck}',${i})" oncontextmenu="clearPad(event,'${deck}',${i})"
      title="${cueSet?'Jump to cue (right-click to clear)':'Click to set cue'}">${lbl}</div>`;
  }).join('');
}
function triggerPad(deck,idx){
  const mode=perfMode[deck];
  if(mode==='hot'){
    if(hotCues[deck][idx]===null){const pos=deck==='A'&&masterAudio?masterAudio.currentTime:0;hotCues[deck][idx]=pos;addLog('system',`Deck ${deck} CUE ${idx+1} set @ ${fmtDur(pos)}`,'—');}
    else{if(deck==='A'&&masterAudio)masterAudio.currentTime=hotCues[deck][idx];addLog('system',`Deck ${deck} CUE ${idx+1} jump`,'—');}
    renderPerfPads(deck);
  } else if(mode==='roll') quickLoop(deck,[0.125,0.25,0.5,1][idx]);
  else if(mode==='slicer'){const ls=loopState[deck];if(ls.inPoint!==null&&ls.outPoint!==null&&deck==='A'&&masterAudio)masterAudio.currentTime=ls.inPoint+(ls.outPoint-ls.inPoint)/4*idx;}
  const pads=document.querySelectorAll('#perfPads'+deck+' .pp');
  if(pads[idx]){pads[idx].classList.add('lit');setTimeout(()=>pads[idx]?.classList.remove('lit'),180);}
}
function clearPad(e,deck,idx){e.preventDefault();if(perfMode[deck]==='hot'){hotCues[deck][idx]=null;renderPerfPads(deck);}}

// ─── FX ENGINE ────────────────────────────────────────
const fxState={A:{on:false,type:'none',wet:50,p1:50,p2:50,beat:1},B:{on:false,type:'none',wet:50,p1:50,p2:50,beat:1}};

function toggleFX(deck){
  fxState[deck].on=!fxState[deck].on;
  const btn=document.getElementById('fxOn'+deck);
  if(btn){btn.textContent=fxState[deck].on?'ON':'OFF';btn.classList.toggle('on',fxState[deck].on);}
  if(fxState[deck].on) activateFX(deck); else deactivateFX(deck);
  addLog('system',`Deck ${deck} FX ${fxState[deck].on?'ON':'OFF'}: ${fxState[deck].type}`,'—');
}
function setFX(deck,type){fxState[deck].type=type;if(fxState[deck].on)activateFX(deck);}
function setFxBeat(deck,beat){
  fxState[deck].beat=beat;
  document.querySelectorAll(`.fx-beat-btn`).forEach(b=>b.classList.remove('on'));
  if(fxState[deck].on) activateFX(deck);
}
function applyFXParam(id,val){
  const m=id.match(/^fx(Wet|P1|P2)([AB])$/); if(!m) return;
  const[,param,deck]=m;
  if(param==='Wet') fxState[deck].wet=val;
  else if(param==='P1') fxState[deck].p1=val;
  else if(param==='P2') fxState[deck].p2=val;
  if(fxState[deck].on) activateFX(deck);
}
function deactivateFX(deck){
  const nodes = fxNodes[deck];
  // 1. Call _stop() for effects that use timers / rAF-style loops
  if(typeof nodes._stop === 'function'){ try{ nodes._stop(); }catch(e){} }
  // 2. Clear any interval IDs stored in _iv
  if(nodes._iv != null){ clearInterval(nodes._iv); }
  // 3. Stop oscillators, disconnect AudioNodes
  Object.values(nodes).forEach(n=>{
    if(!n || typeof n !== 'object') return;
    if(typeof n.stop === 'function'){ try{n.stop();}catch(e){} }
    if(typeof n.disconnect === 'function'){ try{n.disconnect();}catch(e){} }
  });
  fxNodes[deck] = {};
  // 4. Reconnect the dry gain to output
  if(deck==='A' && gainNodeA){ try{gainNodeA.disconnect();}catch(e){} gainNodeA.connect(filterNodeA||masterGain); }
  if(deck==='B' && deckBGain){ try{deckBGain.disconnect();}catch(e){} deckBGain.connect(masterGain); }
}
function activateFX(deck){
  if(!audioCtx) return;
  deactivateFX(deck);
  const fx = fxState[deck], t = fx.type;
  if(t === 'none') return;

  const srcGain = deck === 'A' ? gainNodeA   : deckBGain;
  const target  = deck === 'A' ? (filterNodeA||masterGain) : masterGain;
  const bpmItem = deck === 'A'
    ? STATE.playlist[STATE.nowPlayingIdx]
    : STATE.playlist[deckBTrackIdx >= 0 ? deckBTrackIdx : STATE.nowPlayingIdx+1];
  if(!srcGain || !target) return;

  const bpm     = bpmItem?.bpm || 128;
  const beatSec = 60 / bpm;

  // ══════════════════════════════════════════════════════════════
  //  ECHO — tape delay, tempo-synced, natural decay (no mud)
  // ══════════════════════════════════════════════════════════════
  if(t === 'echo'){
    const delayTime = Math.min(beatSec * (fx.beat || 0.5), 3.9);
    const delay = audioCtx.createDelay(4.0);
    const fb    = audioCtx.createGain();
    const wet   = audioCtx.createGain();
    const hpf   = audioCtx.createBiquadFilter();  // kill bass mud on repeats
    delay.delayTime.value = delayTime;
    fb.gain.value  = 0.42;
    wet.gain.value = 0.6;
    hpf.type = 'highpass'; hpf.frequency.value = 150;
    srcGain.connect(target);
    srcGain.connect(delay);
    delay.connect(hpf); hpf.connect(fb); fb.connect(delay);
    delay.connect(wet); wet.connect(target);
    fxNodes[deck] = { delay, fb, wet, hpf };
  }

  // ══════════════════════════════════════════════════════════════
  //  REVERB — convolution IR, smooth exponential decay, no clang
  // ══════════════════════════════════════════════════════════════
  else if(t === 'reverb'){
    const sr  = audioCtx.sampleRate;
    const dur = 1.5 + (fx.p1 / 100) * 2.5;
    const len = Math.floor(sr * dur);
    const buf = audioCtx.createBuffer(2, len, sr);
    for(let ch = 0; ch < 2; ch++){
      const d = buf.getChannelData(ch);
      for(let i = 0; i < len; i++) d[i] = (Math.random()*2-1) * Math.pow(1 - i/len, 2.8);
    }
    const conv = audioCtx.createConvolver();
    const lpf  = audioCtx.createBiquadFilter();
    const wet  = audioCtx.createGain();
    const dry  = audioCtx.createGain();
    conv.buffer = buf;
    lpf.type = 'lowpass'; lpf.frequency.value = 5500;
    wet.gain.value = 0.5; dry.gain.value = 1.0;
    srcGain.connect(dry);  dry.connect(target);
    srcGain.connect(conv); conv.connect(lpf); lpf.connect(wet); wet.connect(target);
    fxNodes[deck] = { conv, lpf, wet, dry };
  }

  // ══════════════════════════════════════════════════════════════
  //  FLANGER — smooth LFO, subtle comb, no shriek
  // ══════════════════════════════════════════════════════════════
  else if(t === 'flanger'){
    const delay = audioCtx.createDelay(0.05);
    const osc   = audioCtx.createOscillator();
    const lfoG  = audioCtx.createGain();
    const wet   = audioCtx.createGain();
    const fb    = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 0.1 + (fx.p1/100)*0.7;
    lfoG.gain.value = 0.002 + (fx.p2/100)*0.005;
    delay.delayTime.value = 0.004;
    fb.gain.value  = 0.5;
    wet.gain.value = 0.65;
    osc.connect(lfoG); lfoG.connect(delay.delayTime);
    srcGain.connect(target);
    srcGain.connect(delay);
    delay.connect(fb); fb.connect(delay);
    delay.connect(wet); wet.connect(target);
    osc.start();
    fxNodes[deck] = { delay, osc, lfoG, wet, fb };
  }

  // ══════════════════════════════════════════════════════════════
  //  FILTER SWEEP — resonant bandpass LFO (Xone-style)
  // ══════════════════════════════════════════════════════════════
  else if(t === 'filter'){
    const bpf  = audioCtx.createBiquadFilter();
    const lfo  = audioCtx.createOscillator();
    const lfoG = audioCtx.createGain();
    bpf.type = 'bandpass';
    bpf.frequency.value = 800;
    bpf.Q.value = 3.5;
    lfo.type = 'sine';
    lfo.frequency.value = 0.3 + (fx.p1/100)*2;
    lfoG.gain.value = 300 + (fx.p2/100)*700;
    lfo.connect(lfoG); lfoG.connect(bpf.frequency);
    srcGain.connect(target);
    srcGain.connect(bpf); bpf.connect(target);
    lfo.start();
    fxNodes[deck] = { bpf, lfo, lfoG };
  }

  // ══════════════════════════════════════════════════════════════
  //  BITCRUSH — WaveShaper quantisation (no ScriptProcessor lag)
  // ══════════════════════════════════════════════════════════════
  else if(t === 'bitcrush'){
    const bits  = Math.max(2, Math.round(2 + (fx.p1/100)*6));
    const steps = Math.pow(2, bits - 1);
    const N     = 4096;
    const curve = new Float32Array(N);
    for(let i = 0; i < N; i++){
      const x = (i/(N-1))*2-1;
      curve[i] = Math.round(x*steps)/steps;
    }
    const ws  = audioCtx.createWaveShaper();
    const wet = audioCtx.createGain();
    const dry = audioCtx.createGain();
    ws.curve = curve; ws.oversample = '2x';
    wet.gain.value = 0.7; dry.gain.value = 0.4;
    srcGain.connect(dry); dry.connect(target);
    srcGain.connect(ws);  ws.connect(wet); wet.connect(target);
    fxNodes[deck] = { ws, wet, dry };
  }

  // ══════════════════════════════════════════════════════════════
  //  STUTTER — AudioContext-scheduled gate (tight, no setInterval drift)
  // ══════════════════════════════════════════════════════════════
  else if(t === 'stutter'){
    const g   = audioCtx.createGain();
    const wet = audioCtx.createGain();
    g.gain.value   = 1;
    wet.gain.value = 1.0;
    const rate       = 2 + (fx.p1/100)*14;   // 2–16 Hz
    const halfPeriod = 1/(rate*2);
    let _alive = true, _on = true;

    function _tick(){
      if(!_alive) return;
      const now = audioCtx.currentTime;
      g.gain.setValueAtTime(_on ? 1 : 0, now);
      _on = !_on;
      // Schedule next tick ~80ms before it fires
      const nextFire = now + halfPeriod;
      const ahead    = (nextFire - audioCtx.currentTime) * 1000 - 80;
      setTimeout(_tick, Math.max(0, ahead));
    }
    _tick();

    srcGain.connect(target);
    srcGain.connect(g); g.connect(wet); wet.connect(target);
    fxNodes[deck] = { g, wet, _stop: ()=>{ _alive=false; g.gain.setValueAtTime(1, audioCtx.currentTime); } };
  }

  // ══════════════════════════════════════════════════════════════
  //  SLICER — rhythmic amplitude gate with smooth attack/release
  //  Classic DJ loop-slicer sound (different from stutter: shaped envelope)
  // ══════════════════════════════════════════════════════════════
  else if(t === 'slicer'){
    const sliceGain = audioCtx.createGain();
    sliceGain.gain.value = 1;
    // Slices per bar: 4 / 8 / 16 / 32
    const divisions  = [4, 8, 16, 32];
    const divIdx     = Math.floor((fx.p1/100)*3.99);
    const slicesPerBar = divisions[divIdx] || 8;
    const sliceSec   = (beatSec * 4) / slicesPerBar;
    const openSec    = sliceSec * 0.5;   // gate open 50%
    let _alive = true;

    function _schedSlice(){
      if(!_alive) return;
      const now = audioCtx.currentTime;
      sliceGain.gain.cancelScheduledValues(now);
      sliceGain.gain.setValueAtTime(0, now);
      sliceGain.gain.linearRampToValueAtTime(1, now + 0.003);     // 3ms attack
      sliceGain.gain.setValueAtTime(1, now + openSec - 0.003);
      sliceGain.gain.linearRampToValueAtTime(0, now + openSec);   // 3ms release
      setTimeout(_schedSlice, sliceSec * 1000);
    }
    _schedSlice();

    srcGain.connect(target);
    srcGain.connect(sliceGain); sliceGain.connect(target);
    fxNodes[deck] = { sliceGain, _stop: ()=>{ _alive=false; sliceGain.gain.cancelScheduledValues(audioCtx.currentTime); sliceGain.gain.setValueAtTime(1, audioCtx.currentTime); } };
  }

  // ══════════════════════════════════════════════════════════════
  //  PHASER — 4-stage all-pass, slow LFO, rich chorus-phase sound
  // ══════════════════════════════════════════════════════════════
  else if(t === 'phaser'){
    const filters = [];
    for(let i = 0; i < 4; i++){
      const ap = audioCtx.createBiquadFilter();
      ap.type = 'allpass';
      ap.frequency.value = 300 + i * 400;
      ap.Q.value = 6;
      filters.push(ap);
    }
    for(let i = 0; i < 3; i++) filters[i].connect(filters[i+1]);
    const lfo  = audioCtx.createOscillator();
    const lfoG = audioCtx.createGain();
    const wet  = audioCtx.createGain();
    lfo.type = 'sine';
    lfo.frequency.value = 0.1 + (fx.p1/100)*0.6;
    lfoG.gain.value = 500 + (fx.p2/100)*1000;
    wet.gain.value  = 0.75;
    lfo.connect(lfoG);
    filters.forEach(f => lfoG.connect(f.frequency));
    srcGain.connect(target);
    srcGain.connect(filters[0]);
    filters[3].connect(wet); wet.connect(target);
    lfo.start();
    fxNodes[deck] = { lfo, lfoG, wet, f0:filters[0], f1:filters[1], f2:filters[2], f3:filters[3] };
  }

  // ══════════════════════════════════════════════════════════════
  //  VINYL BRAKE — pitch ramp-down then ramp-up (hold = slows, release = returns)
  // ══════════════════════════════════════════════════════════════
  else if(t === 'brake'){
    const audio    = deck === 'A' ? masterAudio : deckBAudio;
    if(!audio) return;
    const origRate = audio.playbackRate;
    const brakeSec = 0.5 + (fx.p1/100)*1.2;
    const steps    = 30;
    const ivMs     = (brakeSec*1000)/steps;
    let s = 0, braking = true;
    const _iv = setInterval(()=>{
      if(!braking){ clearInterval(_iv); return; }
      s++;
      audio.playbackRate = Math.max(0.05, origRate*(1-(s/steps)*(s/steps)));
      if(s >= steps){ braking=false; clearInterval(_iv);
        let rs=0;
        const _iv2=setInterval(()=>{
          rs++; audio.playbackRate = Math.min(origRate, origRate*(rs/steps)*(rs/steps));
          if(rs>=steps){ audio.playbackRate=origRate; clearInterval(_iv2); }
        }, ivMs);
      }
    }, ivMs);
    fxNodes[deck] = { _iv, _stop:()=>{ braking=false; if(audio) audio.playbackRate=origRate; } };
  }

  // ══════════════════════════════════════════════════════════════
  //  TAPE STOP — pitch ramp-down only (one-shot kill)
  // ══════════════════════════════════════════════════════════════
  else if(t === 'tapestop'){
    const audio = deck === 'A' ? masterAudio : deckBAudio;
    if(!audio) return;
    const origRate = audio.playbackRate;
    const dur=1.2+(fx.p1/100)*1.5; const steps=40; const ivMs=(dur*1000)/steps;
    let s=0;
    const _iv=setInterval(()=>{
      s++; audio.playbackRate=Math.max(0.001, origRate*Math.pow(1-s/steps,2));
      if(s>=steps){ clearInterval(_iv); audio.playbackRate=origRate; }
    }, ivMs);
    fxNodes[deck] = { _iv, _stop:()=>{ if(audio) audio.playbackRate=origRate; } };
  }
}
// ─── CROSSFADER ───────────────────────────────────────
let cfCurve='cut';

function setCfCurve(curve){
  cfCurve=curve;
  document.getElementById('cfCutA')?.classList.toggle('on',curve==='cut');
  document.getElementById('cfLinA')?.classList.toggle('on',curve==='linear');
  document.getElementById('cfSmoA')?.classList.toggle('on',curve==='smooth');
}
function updateCrossfader(val){
  val=parseInt(val);
  let lbl='Center';
  if(val<45) lbl='← A '+(Math.round((50-val)*2))+'%';
  else if(val>55) lbl='B '+(Math.round((val-50)*2))+'% →';
  const cp=document.getElementById('cfPos'); if(cp) cp.textContent=lbl;
  if(!audioCtx) return;
  const t=audioCtx.currentTime;
  let gA,gB;
  if(cfCurve==='cut'){
    gA=val<=50?1:Math.max(0,1-(val-50)/50);
    gB=val>=50?1:Math.max(0,1-(50-val)/50);
  } else if(cfCurve==='linear'){
    gA=1-val/100; gB=val/100;
  } else {
    gA=Math.cos((val/100)*Math.PI/2);
    gB=Math.cos(((100-val)/100)*Math.PI/2);
  }
  if(gainNodeA) gainNodeA.gain.setTargetAtTime(gA*(deckFaderState.A/100),t,0.01);
  if(deckBGain)  deckBGain.gain.setTargetAtTime(gB*(deckFaderState.B/100),t,0.01);
}
function centerCrossfader(){const cf=document.getElementById('crossfader');if(cf)cf.value=50;updateCrossfader(50);}

// ─── AUTO-FADE ────────────────────────────────────────
let autoFadeOn=false,fadeDuration=8,fadeInterval=null,fadeCurveMode='Linear';
const CURVE_NAMES=['','Slow-In','Ease-In','Ease','Linear','Ease-Out','Ease-Out+','Expo','Log','S-Curve','Fast-Cut'];
function toggleAutoFade(){
  autoFadeOn=!autoFadeOn;
  const b=document.getElementById('afBtn');if(b){b.textContent=autoFadeOn?'ON':'OFF';b.className='af-toggle-btn'+(autoFadeOn?' on':'');}
  const pl=document.getElementById('afProgLbl');if(pl)pl.textContent=autoFadeOn?'ARMED':'Standby';
  const dot=document.getElementById('afDot');if(dot)dot.className='af-prog-dot'+(autoFadeOn?' fading':'');
}
function updateAfDur(v){fadeDuration=parseInt(v);const e=document.getElementById('afDurVal');if(e)e.textContent=v+'s';}
function updateAfCurve(v){fadeCurveMode=CURVE_NAMES[parseInt(v)]||'Linear';const e=document.getElementById('afCurveVal');if(e)e.textContent=fadeCurveMode;}
// fadeSide: 'AtoB' (crossfader left→right) or 'BtoA' (right→left)
// onDone: optional callback when fade completes
function triggerManualFade(fadeSide, onDone){
  if(fadeInterval){ clearInterval(fadeInterval); fadeInterval=null; }
  fadeSide = fadeSide || 'AtoB';
  let step=0, total=Math.max(1, fadeDuration*20);

  // Capture start position of crossfader
  const cfEl = document.getElementById('crossfader');
  const startVal = cfEl ? parseInt(cfEl.value) : (fadeSide==='AtoB' ? 0 : 100);
  const endVal   = fadeSide==='AtoB' ? 100 : 0;

  document.getElementById('afDot')?.classList.add('fading');
  const pl=document.getElementById('afProgLbl'); if(pl) pl.textContent='Fading…';

  fadeInterval=setInterval(()=>{
    step++;
    let t=step/total;
    // Apply curve
    if(fadeCurveMode==='Ease-In')            t=t*t;
    else if(fadeCurveMode==='Ease-Out'
         || fadeCurveMode==='Ease-Out+')     t=1-(1-t)*(1-t);
    else if(fadeCurveMode==='Expo')          t=Math.pow(t,3);
    else if(fadeCurveMode==='S-Curve')       t=t<0.5?2*t*t:1-2*(1-t)*(1-t);
    else if(fadeCurveMode==='Fast-Cut')      t=t>0.8?1:0;

    const cfVal = Math.round(startVal + (endVal-startVal)*t);
    if(cfEl) cfEl.value = cfVal;
    updateCrossfader(cfVal);

    const pf=document.getElementById('afProgFill');
    if(pf) pf.style.width=(t*100)+'%';

    if(step>=total){
      clearInterval(fadeInterval); fadeInterval=null;
      document.getElementById('afDot')?.classList.remove('fading');
      const pl=document.getElementById('afProgLbl');
      if(pl) pl.textContent=autoFadeOn?'ARMED':'Complete';
      addLog('system',`Auto-Fade done (${fadeDuration}s ${fadeCurveMode} ${fadeSide})`,'—');
      if(typeof onDone==='function') onDone();
    }
  }, 1000/20);

  addLog('system',`Auto-Fade → ${fadeSide} (${fadeDuration}s ${fadeCurveMode})`,'—');
}

// Auto-fade: fires automatically when current song is within fadeDuration seconds of end
// Called from onAudioTimeUpdate — checks if armed and in the fade window
let _autoFadeFired = false;
function checkAutoFade(){
  if(!autoFadeOn || !STATE.playing || fadeInterval) return;

  // ── Always measure the CURRENTLY PLAYING audio element ──
  const activeAudio = activeDeck === 'A' ? masterAudio : deckBAudio;
  if(!activeAudio) return;
  const remaining = (activeAudio.duration||0) - (activeAudio.currentTime||0);

  // Reset the fired flag once the active song has plenty of time left
  if(remaining > fadeDuration + 2) _autoFadeFired = false;

  if(remaining <= fadeDuration && remaining > 0 && !_autoFadeFired){
    _autoFadeFired = true;

    const nextIdx = STATE.nowPlayingIdx + 1;
    if(nextIdx >= STATE.playlist.length){
      triggerManualFade(activeDeck === 'A' ? 'AtoB' : 'BtoA');
      return;
    }

    const incomingDeck = activeDeck === 'A' ? 'B' : 'A';
    const fadeSide     = activeDeck === 'A' ? 'AtoB' : 'BtoA';

    // ── Load the incoming deck ──
    if(incomingDeck === 'B'){
      loadDeckB(nextIdx);         // loads song onto deckBAudio, does NOT change nowPlayingIdx
    } else {
      // Pre-buffer next song onto masterAudio WITHOUT touching nowPlayingIdx
      _preBufferDeckA(nextIdx);
    }

    setTimeout(()=>{
      // Start incoming deck playing
      if(incomingDeck === 'B'){
        if(deckBAudio && !deckState.B.playing){
          deckBAudio.play().then(()=>{
            deckState.B.playing=true; platters.B.spinning=true;
            const pb=document.getElementById('playB');
            if(pb){ pb.textContent='⏸ PAUSE'; pb.classList.add('playing'); }
          }).catch(()=>{});
        }
      } else {
        if(masterAudio){
          audioCtx?.resume(); setupEQ();
          masterAudio.play().then(()=>{
            STATE.playing=true; STATE.paused=false; setPlayingUI(true);
          }).catch(()=>{});
        }
      }

      // Position crossfader on the outgoing side
      const cfVal = activeDeck === 'A' ? 0 : 100;
      const cfEl  = document.getElementById('crossfader');
      if(cfEl) cfEl.value = cfVal;
      updateCrossfader(cfVal);

      triggerManualFade(fadeSide, ()=>{
        // ════════════════════════════════════════════════════
        //  FADE COMPLETE — clean, minimal state transition
        // ════════════════════════════════════════════════════
        const prevDeck    = activeDeck;
        activeDeck        = incomingDeck;
        // Advance playlist pointer to the song now playing
        STATE.nowPlayingIdx = nextIdx;
        deckBTrackIdx       = (activeDeck === 'B') ? nextIdx : deckBTrackIdx;

        // Stop + silence the outgoing deck
        if(prevDeck === 'A'){
          // masterAudio was the outgoing song — pause it so 'ended' can't fire
          if(masterAudio){ masterAudio.pause(); masterAudio.src=''; }
        } else {
          // deckBAudio was outgoing — pause it
          if(deckBAudio){ deckBAudio.pause(); deckBAudio.currentTime=0; }
          deckState.B.playing=false; platters.B.spinning=false;
          const pb=document.getElementById('playB');
          if(pb){ pb.textContent='▶ PLAY'; pb.classList.remove('playing'); }
        }

        // Attach a one-shot ended handler to the NOW-ACTIVE audio
        // so the NEXT autofade (or manual advance) works correctly
        if(activeDeck === 'B'){
          // B is now playing — attach ended handler for non-autofade fallback
          if(deckBAudio){
            deckBAudio.addEventListener('ended', function _bEnd(){
              if(activeDeck !== 'B') return;
              deckState.B.playing=false; platters.B.spinning=false;
              const pb=document.getElementById('playB');
              if(pb){ pb.textContent='▶ PLAY'; pb.classList.remove('playing'); }
              addLog('song','Deck B song ended','—');
              // Autofade would normally have already handled the next song;
              // this fires only if autofade is OFF or was somehow skipped.
              if(!autoFadeOn && STATE.autoplay && !STATE.assistMode){
                activeDeck='A';
                const ni=STATE.nowPlayingIdx+1;
                if(ni < STATE.playlist.length) loadTrackAndPlay(ni, true);
                else { STATE.nowPlayingIdx=-1; updateNowPlayingDisplay(); renderPlaylist(); }
              }
            }, {once:true});
          }
          // Pre-load song AFTER nextIdx onto Deck A silently
          const upNext = nextIdx + 1;
          if(upNext < STATE.playlist.length) _preBufferDeckA(upNext);

        } else {
          // A is now active — masterAudio already playing via _preBufferDeckA + setupEQ above
          // NOW it's safe to update Deck A's wavestrip to the song that's actually playing
          const activeItem = STATE.playlist[STATE.nowPlayingIdx];
          if(activeItem){
            const wA = document.getElementById('waveStripA');
            if(wA){ wA.width=wA.offsetWidth||300; wA.height=wA.offsetHeight||34; drawWaveStrip('A', activeItem); }
          }
          // Pre-load song after nextIdx onto Deck B
          const upNext = nextIdx + 1;
          if(upNext < STATE.playlist.length) loadDeckB(upNext);
        }

        recalcPlaylistTimes();
        updateNowPlayingDisplay();
        updateDeckDisplays();
        renderPlaylist();
        addLog('system','AutoFade done → Deck '+activeDeck+' · '+(STATE.playlist[STATE.nowPlayingIdx]?.title||''),'—');
        showToast('✓ Faded → Deck '+activeDeck+' · '+(STATE.playlist[STATE.nowPlayingIdx]?.title||''));
        // Reset so the next song's fade can trigger when remaining drops low again
        _autoFadeFired = false;
      });
    }, 300);
  }
}

// ── Silent pre-buffer of a song onto masterAudio/Deck A ──────────────
// Loads audio + wires event listeners WITHOUT touching STATE.nowPlayingIdx
// or doing any playlist mutation. Used during autofade pre-staging only.
function _preBufferDeckA(idx){
  const item = STATE.playlist[idx];
  if(!item?.fileObj) return;
  initAudioCtx();
  if(masterSource){ try{masterSource.disconnect();}catch(e){} masterSource=null; }
  if(masterAudio){ masterAudio.pause(); masterAudio.src=''; }
  masterAudio = new Audio();
  masterAudio.crossOrigin='anonymous';
  masterAudio.src = URL.createObjectURL(item.fileObj);
  masterAudio.playbackRate = 1 + tempoState.A/100;
  masterAudio.addEventListener('timeupdate', _deckATimeUpdate);
  masterAudio.addEventListener('ended',      onAudioEnded);
  masterAudio.addEventListener('loadedmetadata', onAudioMetadata);
  masterAudio.addEventListener('error', ()=>setPlayingUI(false));
  masterAudio._outroFired = false;
  // NOTE: do NOT reset _autoFadeFired here — that would re-trigger the fade immediately
  // NOTE: do NOT draw waveStripA or update deck A title — deck B is the active/visible deck
  addLog('system','Pre-buffered Deck A: '+(item.artist||item.title),'—');
}


// ─── DJ DECK CONTROLS ─────────────────────────────────
const deckState={A:{playing:false,cue:0},B:{playing:false,cue:0}};
const pflState={A:false,B:false};
const syncState={A:false,B:false};

function djTogglePlay(deck){
  if(deck==='A'){
    if(STATE.playing){masterPause();deckState.A.playing=false;}
    else{masterPlay();deckState.A.playing=true;}
  } else {
    // Deck B - uses independent audio engine
    if(!deckBAudio||!deckBAudio.src){
      // Auto-load next track in playlist if nothing loaded
      const autoIdx = (deckBTrackIdx>=0) ? deckBTrackIdx :
                      (STATE.nowPlayingIdx>=0 ? STATE.nowPlayingIdx+1 : 0);
      if(autoIdx < STATE.playlist.length){ loadDeckB(autoIdx); }
      else { showToast('Drop a song onto Deck B from the playlist'); return; }
    }
    if(!audioCtx) initAudioCtx();
    if(audioCtx.state==='suspended') audioCtx.resume();
    deckState.B.playing = !deckState.B.playing;
    platters.B.spinning = deckState.B.playing;
    if(deckState.B.playing){
      deckBAudio.play().then(()=>{
        addLog('song','Deck B play: '+(STATE.playlist[deckBTrackIdx]?.artist||'—'),fmtDur(deckBAudio.duration||0));
      }).catch(e=>{ deckState.B.playing=false; platters.B.spinning=false; showToast('Deck B play error: '+e.message); });
    } else {
      deckBAudio.pause();
    }
    const pb=document.getElementById('playB');
    if(pb){pb.textContent=deckState.B.playing?'⏸ PAUSE':'▶ PLAY';pb.classList.toggle('playing',deckState.B.playing);}
    const rb=document.getElementById('platterRpmB');
    if(rb)rb.textContent=(33.3*(1+tempoState.B/100)).toFixed(1)+' RPM · '+(deckState.B.playing?'PLAY':'STOP');
  }
}
function djCue(deck){
  if(deck==='A'&&masterAudio){
    if(!STATE.playing){masterAudio.currentTime=deckState.A.cue||0;}
    else{deckState.A.cue=masterAudio.currentTime;masterPause();}
    document.getElementById('cueA')?.classList.add('cued');
    addLog('system',`Deck A CUE @ ${fmtDur(deckState.A.cue)}`,'—');
  } else if(deck==='B'){
    if(deckBAudio){
      if(deckState.B.playing){
        deckState.B.cue=deckBAudio.currentTime;
        deckBAudio.pause(); deckState.B.playing=false; platters.B.spinning=false;
        const pb=document.getElementById('playB');
        if(pb){pb.textContent='▶ PLAY';pb.classList.remove('playing');}
      } else {
        deckBAudio.currentTime=deckState.B.cue||0;
      }
    }
    document.getElementById('cueB')?.classList.add('cued');
    addLog('system',`Deck B CUE @ ${fmtDur(deckState.B?.cue||0)}`,'—');
  }
}
function djPFL(deck){
  pflState[deck]=!pflState[deck];
  document.getElementById('pfl'+deck)?.classList.toggle('on',pflState[deck]);
  document.getElementById('pflDot'+deck)?.classList.toggle('on-'+deck.toLowerCase(),pflState[deck]);
}
// ─── BPM ENGINE ──────────────────────────────────────────────
// Live BPM per deck — detected or tapped
const liveBpm={A:null, B:null};

// ── Tap Tempo ──────────────────────────────────────────────
const tapTimes={A:[], B:[]};
function tapTempo(deck){
  const now=performance.now();
  const arr=tapTimes[deck];
  // Reset tap sequence if gap > 3 seconds
  if(arr.length>0 && now-arr[arr.length-1]>3000) arr.length=0;
  arr.push(now);
  if(arr.length<2) { updateBpmDisplay(deck, null, 'TAP…'); return; }
  // Keep last 8 taps max
  if(arr.length>8) arr.shift();
  // Average interval
  let total=0;
  for(let i=1;i<arr.length;i++) total+=arr[i]-arr[i-1];
  const avgMs=total/(arr.length-1);
  const bpm=Math.round(60000/avgMs);
  if(bpm>=40&&bpm<=220){
    liveBpm[deck]=bpm;
    setItemBpm(deck, bpm);
    updateBpmDisplay(deck, bpm, 'TAP');
    updateSyncDiff();
    addLog('system',`Deck ${deck} tap BPM: ${bpm}`,'—');
  }
}

// ── Auto-detect BPM from audio file (offline analysis) ────
async function autoDetectBpm(deck){
  const item = deck==='A'
    ? STATE.playlist[STATE.nowPlayingIdx]
    : STATE.playlist[deckBTrackIdx>=0 ? deckBTrackIdx : STATE.nowPlayingIdx+1];
  if(!item?.fileObj){ showToast('Load a track on Deck '+deck+' first'); return; }

  const btn=document.getElementById('bpmDetect'+deck);
  if(btn){ btn.textContent='…'; btn.disabled=true; }
  updateBpmDisplay(deck, null, 'ANALYZING…');

  try{
    // Decode in a dedicated short-lived AudioContext.
    // NEVER use the main audioCtx — decodeAudioData() transfers (detaches) the
    // ArrayBuffer which would destroy the currently playing audio graph.
    const arrayBuf = await item.fileObj.arrayBuffer();
    const bpmCtx = new AudioContext();
    let audioBuf;
    try {
      audioBuf = await bpmCtx.decodeAudioData(arrayBuf.slice(0));
    } finally {
      bpmCtx.close();
    }

    const sampleRate = audioBuf.sampleRate;
    const analyseSecs = Math.min(60, audioBuf.duration);
    const numSamples = Math.floor(analyseSecs * sampleRate);
    const raw = audioBuf.getChannelData(0);

    // ── Step 1: RMS energy envelope (hop = 512 samples) ──────────────
    const hop = 512;
    const rms = [];
    for(let i = 0; i + hop < numSamples; i += hop){
      let sum = 0;
      for(let j = i; j < i + hop; j++) sum += raw[j] * raw[j];
      rms.push(Math.sqrt(sum / hop));
    }

    // ── Step 2: Half-wave rectified first difference (onset strength) ─
    const onset = [];
    for(let i = 1; i < rms.length; i++) onset.push(Math.max(0, rms[i] - rms[i-1]));
    const N = onset.length;
    const fps = sampleRate / hop;   // onset frames per second

    // ── Step 3: Autocorrelation over lag range [40–220 BPM] ──────────
    const minLag = Math.max(1,  Math.floor(fps * 60 / 220));
    const maxLag = Math.min(Math.floor(N / 2), Math.ceil(fps * 60 / 40));

    const acf = {};   // bpm (integer) → max correlation value
    for(let lag = minLag; lag <= maxLag; lag++){
      let s = 0;
      for(let i = 0; i < N - lag; i++) s += onset[i] * onset[i + lag];
      const bpmK = Math.round(60 * fps / lag);
      if(bpmK >= 40 && bpmK <= 220){
        if(acf[bpmK] === undefined || acf[bpmK] < s) acf[bpmK] = s;
      }
    }

    if(!Object.keys(acf).length) throw new Error('No autocorrelation data');

    // ── Step 4: Pick best BPM — strong bias toward 80–180 (music range) ─
    let bestBpm = 120, bestScore = 0;
    Object.entries(acf).forEach(([b, s]) => {
      const bi = parseInt(b);
      const bias = (bi >= 80 && bi <= 180) ? 1.5
                 : (bi >= 60 && bi <= 220) ? 0.7
                 : 0.3;
      if(s * bias > bestScore){ bestScore = s * bias; bestBpm = bi; }
    });

    liveBpm[deck] = bestBpm;
    item.bpm = bestBpm;
    setItemBpm(deck, bestBpm);
    updateBpmDisplay(deck, bestBpm, 'AUTO');
    updateSyncDiff();
    addLog('system', `Deck ${deck} BPM: ${bestBpm}`, item.title);
    showToast(`Deck ${deck}: ${bestBpm} BPM detected`);

  }catch(e){
    console.error('BPM detect error:', e);
    updateBpmDisplay(deck, null, 'ERR');
    showToast('BPM detection failed: ' + e.message.substring(0,50));
  }finally{
    if(btn){ btn.textContent='⚡ DETECT '+deck; btn.disabled=false; }
  }
}

// ── Write BPM back to the item (playlist + file library) ──
function setItemBpm(deck, bpm){
  const item = deck==='A'
    ? STATE.playlist[STATE.nowPlayingIdx]
    : STATE.playlist[deckBTrackIdx>=0 ? deckBTrackIdx : STATE.nowPlayingIdx+1];
  if(item) item.bpm=bpm;
  // Also update file library entry
  if(item?.fileObj){
    const fi=STATE.fileLibrary.find(f=>f.fileObj===item.fileObj);
    if(fi){ fi.bpm=bpm; saveTrackMeta(); }
  }
}

// ── Update BPM displays ────────────────────────────────────
function updateBpmDisplay(deck, bpm, label){
  const valEl=document.getElementById('syncBpm'+deck);
  const stEl=document.getElementById('bpm'+deck+'State');
  const deckBpmEl=document.getElementById('deckABpm'); // deck header BPM
  if(valEl) valEl.textContent=bpm!=null?bpm:'—';
  if(stEl) stEl.textContent=label||'';
  // Update the deck header BPM readout
  const hdrEl=document.getElementById('deck'+(deck==='A'?'A':'B')+'Bpm');
  if(hdrEl&&bpm) hdrEl.textContent=bpm;
}

// ── Update sync diff display ───────────────────────────────
function updateSyncDiff(){
  const diff=document.getElementById('syncDiff'); if(!diff) return;
  const a=liveBpm.A, b=liveBpm.B;
  if(!a&&!b){ diff.className='sync-diff'; diff.textContent='Tap or auto-detect'; return; }
  if(!a||!b){ diff.className='sync-diff warn'; diff.textContent=(!a?'A':'B')+' BPM needed'; return; }
  const delta=Math.abs(a-b);
  if(delta<0.5){
    diff.className='sync-diff ok';
    diff.textContent='✓ Matched — '+a+' BPM';
  } else if(delta<=3){
    diff.className='sync-diff close';
    diff.textContent='≈ Close — Δ'+delta.toFixed(1)+' BPM';
  } else {
    diff.className='sync-diff warn';
    diff.textContent='Δ '+delta.toFixed(1)+' BPM off';
  }
}

// ── Sync deck speed to match the other deck's BPM ─────────
function djSyncDeckToMaster(deck){
  const srcBpm = deck==='A' ? liveBpm.A : liveBpm.B;
  const tgtBpm = deck==='A' ? liveBpm.B : liveBpm.A;  // sync A to B, or B to A
  if(!srcBpm||!tgtBpm){ showToast('Detect BPM on both decks first'); return; }

  const ratio=tgtBpm/srcBpm;
  const pct=(ratio-1)*100;
  if(deck==='A'&&masterAudio){
    masterAudio.playbackRate=ratio;
    const ts=document.getElementById('tempoA'); if(ts) ts.value=pct.toFixed(1);
    setTempo('A', pct);
  } else if(deck==='B'&&deckBAudio){
    deckBAudio.playbackRate=ratio;
    const ts=document.getElementById('tempoB'); if(ts) ts.value=pct.toFixed(1);
    setTempo('B', pct);
  }
  // Update liveBpm after sync (now effectively matching target)
  liveBpm[deck]=tgtBpm;
  updateBpmDisplay(deck, tgtBpm, 'SYNCED');
  updateSyncDiff();
  const btn=document.getElementById('sync'+deck);
  if(btn){ btn.classList.add('synced'); btn.textContent='🔗 SYNC'; }
  addLog('system',`Deck ${deck} synced: ${srcBpm}→${tgtBpm} BPM (${pct>=0?'+':''}${pct.toFixed(1)}%)`,'—');
  showToast(`Deck ${deck} synced to ${tgtBpm} BPM`);
}

// Keep old djSync callable from the SYNC buttons on each deck
function djSync(deck){
  djSyncDeckToMaster(deck);
}

// Reset both tempos to 0
function bpmReset(){
  ['A','B'].forEach(dk=>{
    tempoState[dk]=0;
    const sl=document.getElementById('tempo'+dk); if(sl) sl.value=0;
    setTempo(dk,0);
    const btn=document.getElementById('sync'+dk);
    if(btn){ btn.classList.remove('synced'); btn.textContent='SYNC'; }
  });
  showToast('Tempos reset');
}

// ── Live BPM tracking from analyser (updates every ~0.5s) ──
// Uses onset energy method on real-time analyser data
let _bpmLiveHistory={A:[], B:[]};
let _bpmLastEnergy={A:0, B:0};
let _bpmLastPeak={A:0, B:0};
const BPM_TRACK_INTERVAL=500; // ms

function tickLiveBpm(){
  // Only update if not already auto-detected from file
  // Use master analyser for deck A, estimate for deck B
  if(masterAnalyser && STATE.playing){
    masterAnalyser.getByteFrequencyData(masterAnalyserData);
    // Sum bass bins (approx 0-200 Hz = first ~5 bins at 44100/256 FFT)
    let bassEnergy=0;
    for(let i=0;i<5;i++) bassEnergy+=masterAnalyserData[i];
    bassEnergy/=5;
    const prev=_bpmLastEnergy.A;
    _bpmLastEnergy.A=bassEnergy;
    // Detect beat: energy spike
    if(bassEnergy>prev*1.3 && bassEnergy>60 && performance.now()-_bpmLastPeak.A>250){
      _bpmLiveHistory.A.push(performance.now());
      _bpmLastPeak.A=performance.now();
      // Flash wavestrip on beat
      const ww=document.getElementById('waveWrapA');
      if(ww){ ww.classList.remove('beat-flash'); void ww.offsetWidth; ww.classList.add('beat-flash'); }
      if(_bpmLiveHistory.A.length>16) _bpmLiveHistory.A.shift();
      if(_bpmLiveHistory.A.length>=4){
        const intervals=[];
        for(let i=1;i<_bpmLiveHistory.A.length;i++)
          intervals.push(_bpmLiveHistory.A[i]-_bpmLiveHistory.A[i-1]);
        const avg=intervals.reduce((a,b)=>a+b,0)/intervals.length;
        const bpm=Math.round(60000/avg);
        if(bpm>=60&&bpm<=180 && (!liveBpm.A || Math.abs(liveBpm.A-bpm)>8)){
          liveBpm.A=bpm;
          updateBpmDisplay('A', bpm, 'LIVE');
          updateSyncDiff();
        }
      }
    }
  }
}
setInterval(tickLiveBpm, 50);

// ─── WAVESTRIP SEEK ───────────────────────────────────
function waveSeek(deck,e){
  // Scrolling waveform: playhead is at center.
  // Click position relative to center maps to ±30 seconds offset.
  const r=e.currentTarget.getBoundingClientRect();
  const clickFrac=(e.clientX-r.left)/r.width; // 0..1 across canvas
  const offsetFromCenter=clickFrac-0.5;        // -0.5..+0.5
  const windowSec=30;                           // visible window = ±30s
  const seekOffset=offsetFromCenter*windowSec*2;
  if(deck==='A'&&masterAudio&&STATE.durSec){
    masterAudio.currentTime=Math.max(0,Math.min(STATE.durSec,masterAudio.currentTime+seekOffset));
  } else if(deck==='B'&&deckBAudio&&deckBAudio.duration){
    deckBAudio.currentTime=Math.max(0,Math.min(deckBAudio.duration,deckBAudio.currentTime+seekOffset));
  }
}

// ─── TURNTABLE ENGINE ─────────────────────────────────
const PL_SIZE=172,PL_RPM=33.3;
const platters={
  A:{angle:0,spinning:false,isDragging:false,lastAngle:0,ctx:null,el:null,color:'#3a8fff'},
  B:{angle:0,spinning:false,isDragging:false,lastAngle:0,ctx:null,el:null,color:'#00cc50'},
};
let platterRAF=0,lastFrameTime=0;

function initPlatters(){
  ['A','B'].forEach(id=>{
    const p=platters[id];
    const el=document.getElementById('platter'+id); if(!el) return;
    el.width=PL_SIZE; el.height=PL_SIZE;
    p.el=el; p.ctx=el.getContext('2d');

    // ── Vinyl drag → audio scrub ──
    let scratchStartAngle=0, scratchStartTime=0;
    el.onmousedown=e=>{
      p.isDragging=true;
      p.lastAngle=getAngle(e,el);
      scratchStartAngle=p.lastAngle;
      scratchStartTime = id==='A'?(masterAudio?.currentTime||0):(deckBAudio?.currentTime||0);
      e.preventDefault();
    };
    el.ontouchstart=e=>{
      p.isDragging=true;
      p.lastAngle=getTouchAngle(e,el);
      scratchStartAngle=p.lastAngle;
      scratchStartTime = id==='A'?(masterAudio?.currentTime||0):(deckBAudio?.currentTime||0);
      e.preventDefault();
    };
    el.ontouchmove=e=>{
      if(!p.isDragging) return;
      const a=getTouchAngle(e,el);
      const diff=angleDiff(a,p.lastAngle);
      p.angle+=diff*2;
      p.lastAngle=a;
      // Scrub: each full rotation = 2 seconds of audio
      const totalDiff=angleDiff(a,scratchStartAngle);
      const seekOffset=(totalDiff/(2*Math.PI))*2;
      const dur = id==='A'?(masterAudio?.duration||0):(deckBAudio?.duration||0);
      if(dur>0){
        const newT=Math.max(0,Math.min(dur,scratchStartTime+seekOffset));
        if(id==='A'&&masterAudio) masterAudio.currentTime=newT;
        else if(id==='B'&&deckBAudio) deckBAudio.currentTime=newT;
      }
      e.preventDefault();
    };
    el.ontouchend=()=>{ p.isDragging=false; };

    const ws=document.getElementById('waveStrip'+id);
    if(ws){ws.width=ws.offsetWidth||300;ws.height=ws.offsetHeight||34;drawEmptyWave(ws,p.color);}
  });

  document.addEventListener('mousemove',e=>{
    ['A','B'].forEach(id=>{
      const p=platters[id]; if(!p.isDragging||!p.el) return;
      const a=getAngle(e,p.el);
      const diff=angleDiff(a,p.lastAngle);
      p.angle+=diff*2;
      p.lastAngle=a;
      // Scrub audio
      const scratchSpeed=diff*6; // radians → seconds (approx)
      if(id==='A'&&masterAudio&&masterAudio.duration){
        masterAudio.currentTime=Math.max(0,Math.min(masterAudio.duration,masterAudio.currentTime+scratchSpeed));
      } else if(id==='B'&&deckBAudio&&deckBAudio.duration){
        deckBAudio.currentTime=Math.max(0,Math.min(deckBAudio.duration,deckBAudio.currentTime+scratchSpeed));
      }
    });
  });
  document.addEventListener('mouseup',()=>{platters.A.isDragging=false;platters.B.isDragging=false;});
  if(!platterRAF) platterRAF=requestAnimationFrame(platterLoop);
  // Start wavestrip animation loop
  animateWavestrips();
}

function platterLoop(ts){
  platterRAF=requestAnimationFrame(platterLoop);
  const dt=lastFrameTime?Math.min((ts-lastFrameTime)/1000,0.1):0.016;
  lastFrameTime=ts;
  ['A','B'].forEach(id=>{
    const p=platters[id]; if(!p.ctx) return;
    if(id==='A'&&STATE.playing&&masterAudio){
      p.angle+=((PL_RPM*(1+tempoState.A/100))/60*2*Math.PI)*dt;
      p.spinning=true;
    } else if(p.spinning&&!p.isDragging){
      p.angle+=((PL_RPM*(id==='A'?1+tempoState.A/100:1+tempoState.B/100))/60*2*Math.PI)*dt;
    }
    drawPlatter(p,id);
  });
}

function drawPlatter(p,id){
  const ctx=p.ctx,sz=PL_SIZE,c=sz/2,r=c-2;
  ctx.clearRect(0,0,sz,sz);
  ctx.save(); ctx.translate(c,c); ctx.rotate(p.angle);
  const grd=ctx.createRadialGradient(0,0,2,0,0,r);
  grd.addColorStop(0,'#2a2a2a');grd.addColorStop(0.15,'#181818');grd.addColorStop(1,'#0c0c0c');
  ctx.beginPath();ctx.arc(0,0,r,0,Math.PI*2);ctx.fillStyle=grd;ctx.fill();
  ctx.strokeStyle='rgba(255,255,255,0.035)';
  for(let i=28;i<r-8;i+=4){ctx.beginPath();ctx.arc(0,0,i,0,Math.PI*2);ctx.lineWidth=0.5;ctx.stroke();}
  const lr=r*0.36,lg=ctx.createRadialGradient(0,0,0,0,0,lr);
  lg.addColorStop(0,'#1a1a30');lg.addColorStop(1,'#0e0e1e');
  ctx.beginPath();ctx.arc(0,0,lr,0,Math.PI*2);ctx.fillStyle=lg;ctx.fill();
  ctx.beginPath();ctx.arc(0,0,lr,0,Math.PI*2);ctx.strokeStyle=p.color+'55';ctx.lineWidth=2;ctx.stroke();
  ctx.fillStyle=p.color;ctx.font=`bold ${sz*0.055}px Courier New`;ctx.textAlign='center';
  ctx.fillText('FM',0,sz*0.02);
  ctx.fillStyle='rgba(255,255,255,0.4)';ctx.font=`${sz*0.038}px Courier New`;
  ctx.fillText('BROADCAST',0,sz*0.062);
  ctx.beginPath();ctx.arc(0,0,4,0,Math.PI*2);ctx.fillStyle='#aaa';ctx.fill();
  ctx.beginPath();ctx.arc(0,0,2,0,Math.PI*2);ctx.fillStyle=p.color;ctx.fill();
  ctx.fillStyle='rgba(255,255,255,0.55)';
  for(let i=0;i<32;i++){const a=(i/32)*Math.PI*2;ctx.beginPath();ctx.arc(Math.cos(a)*(r-5),Math.sin(a)*(r-5),1,0,Math.PI*2);ctx.fill();}
  ctx.restore();
  ctx.beginPath();ctx.arc(c,c,r,0,Math.PI*2);
  ctx.strokeStyle=p.spinning?p.color+'55':'#1a1a28';ctx.lineWidth=2;ctx.stroke();
}

// ─── WAVESTRIP ENGINE — CapCut-style live audio level display ──
// Approach:
//  - Decode audio file into a full-resolution waveform on load (overview)
//  - In animateWavestrips, render a scrolling window centered on playhead
//  - Width of each bar = RMS amplitude at that time position
//  - Color shifts: quiet=dim, mid=base color, loud=bright+warm
//  - Beat flashes from BPM engine pulse the strip
// ──────────────────────────────────────────────────────────────

// Waveform overview data: array of RMS values, one per pixel column when
// rendered at 1px/sample-block.  Indexed by fileObj identity.
const waveformCache = new WeakMap();    // fileObj → Float32Array of RMS values
const waveformReady = {A:false, B:false};
let waveRAF = 0;

function drawEmptyWave(canvas, color){
  if(!canvas) return;
  const w = canvas.width||300, h = canvas.height||26;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle='#020208'; ctx.fillRect(0,0,w,h);
  // Draw a faint gradient line at the bottom (= centre when mirrored)
  const grad = ctx.createLinearGradient(0,0,w,0);
  grad.addColorStop(0,'transparent');
  grad.addColorStop(0.5,(color||'#3a8fff')+'22');
  grad.addColorStop(1,'transparent');
  ctx.fillStyle=grad; ctx.fillRect(0,h-1,w,1);
  // Also clear the mirror canvas
  const canvas2 = document.getElementById((canvas.id||'')+2);
  if(canvas2){
    const ctx2 = canvas2.getContext('2d');
    ctx2.fillStyle='#020208'; ctx2.fillRect(0,0,canvas2.width||w, canvas2.height||h);
  }
}

// Decode audio file and build RMS waveform overview (run once per file)
// Returns a Promise<Float32Array|null>
// Tracks files currently being decoded so parallel calls don't double-decode
const waveformBuilding = new Set();

function buildWaveformOverview(fileObj){
  if(!fileObj) return Promise.resolve(null);

  // Already fully built — return immediately
  const cached = waveformCache.get(fileObj);
  if(cached instanceof Float32Array) return Promise.resolve(cached);

  // Already building — wait for it
  if(waveformBuilding.has(fileObj)){
    return new Promise(resolve=>{
      const check = ()=>{
        const v = waveformCache.get(fileObj);
        if(v instanceof Float32Array){ resolve(v); }
        else if(!waveformBuilding.has(fileObj)){ resolve(null); }
        else { setTimeout(check, 80); }
      };
      check();
    });
  }

  waveformBuilding.add(fileObj);

  const promise = (async()=>{
    try{
      const buf = await fileObj.arrayBuffer();
      // Decode with AudioContext (auto-detects length) rather than OfflineAudioContext
      // which requires knowing the exact sample count upfront
      const audioCtxTmp = new AudioContext();
      const audioBuf = await audioCtxTmp.decodeAudioData(buf.slice(0));
      audioCtxTmp.close();

      const raw = audioBuf.getChannelData(0);
      const totalSamples = raw.length;
      const buckets = 2000;
      const blockSize = Math.max(1, Math.floor(totalSamples / buckets));
      const rms = new Float32Array(buckets);
      for(let i=0; i<buckets; i++){
        let sum=0;
        const start = i * blockSize;
        const end   = Math.min(start + blockSize, totalSamples);
        for(let j=start; j<end; j++) sum += raw[j]*raw[j];
        rms[i] = Math.sqrt(sum / (end - start));
      }
      waveformCache.set(fileObj, rms);
      return rms;
    }catch(e){
      console.warn('Waveform build failed:', e.message);
      return null;
    }finally{
      waveformBuilding.delete(fileObj);
    }
  })();

  return promise;
}

// Kick off background waveform build; triggers re-render when ready
function drawWaveStrip(deck, item){
  const canvas = document.getElementById('waveStrip'+deck);
  if(!canvas) return;
  waveformReady[deck] = false;
  drawEmptyWave(canvas, deck==='A' ? '#3a8fff' : '#00cc50');
  if(!item?.fileObj) return;
  buildWaveformOverview(item.fileObj).then(rms=>{
    if(rms && rms instanceof Float32Array){
      waveformReady[deck] = true;
      // Trigger immediate render so waveform appears right away
      const cur = deck==='A' ? (masterAudio||null) : (deckBAudio||null);
      const cvs = document.getElementById('waveStrip'+deck);
      if(cvs) renderWaveCanvas(deck, cvs, cur, STATE.playing);
    }
  });
}

// Main render: called every rAF frame
function renderWaveCanvas(deck, canvas, audio, isPlaying){
  if(!canvas) return;

  // ── Size sync: set canvas pixel dimensions to match CSS layout ──
  const wrap = canvas.parentElement;
  const wrapW = wrap?.offsetWidth  || canvas.offsetWidth  || 300;
  const halfH = Math.max(1, Math.floor((wrap?.offsetHeight || 52) / 2));

  // Top canvas
  if(canvas.width  !== wrapW) canvas.width  = wrapW;
  if(canvas.height !== halfH) canvas.height = halfH;

  // Bottom (mirror) canvas — same id + "2"
  const canvas2 = document.getElementById(canvas.id + '2');
  if(canvas2){
    if(canvas2.width  !== wrapW) canvas2.width  = wrapW;
    if(canvas2.height !== halfH) canvas2.height = halfH;
  }

  const w = canvas.width;
  const h = canvas.height;
  const ctx  = canvas.getContext('2d');
  const ctx2 = canvas2 ? canvas2.getContext('2d') : null;

  // Deck colours
  const isA    = deck === 'A';
  const colorR = isA ? 58  : 0;
  const colorG = isA ? 143 : 204;
  const colorB = isA ? 255 : 80;
  const colorHex = isA ? '#3a8fff' : '#00cc50';

  // Clear both
  ctx.fillStyle = '#020208'; ctx.fillRect(0,0,w,h);
  if(ctx2){ ctx2.fillStyle = '#020208'; ctx2.fillRect(0,0,w,h); }

  // ── Get waveform data ──
  const fileObj = isA
    ? STATE.playlist[STATE.nowPlayingIdx]?.fileObj
    : STATE.playlist[deckBTrackIdx>=0 ? deckBTrackIdx : STATE.nowPlayingIdx+1]?.fileObj;
  const rms = fileObj ? waveformCache.get(fileObj) : null;

  const dur = audio?.duration   || 0;
  const pos = audio?.currentTime || 0;

  if(!rms || dur === 0){
    // Idle state: dim flat line + faint gradient
    const grad = ctx.createLinearGradient(0,0,w,0);
    grad.addColorStop(0, 'transparent');
    grad.addColorStop(0.5, colorHex+'22');
    grad.addColorStop(1, 'transparent');
    ctx.fillStyle = grad; ctx.fillRect(0, h/2-1, w, 2);
    if(ctx2){ ctx2.fillStyle = grad; ctx2.fillRect(0, h/2-1, w, 2); }
    return;
  }

  // ── Scrolling window: ±15 seconds around playhead ──
  const windowSec = 15;
  const secPerPx  = (windowSec * 2) / w;
  const cx        = Math.floor(w / 2);   // playhead pixel

  // Pre-normalise: find peak RMS for this track so bars fill the canvas
  // (do once per render — fast on a 2000-bucket array)
  let peakRms = 0;
  for(let i = 0; i < rms.length; i++) if(rms[i] > peakRms) peakRms = rms[i];
  const scale = peakRms > 0 ? 1 / peakRms : 1;

  // ── Draw bars column by column ──
  for(let px = 0; px < w; px++){
    const tSec = pos + (px - cx) * secPerPx;
    if(tSec < 0 || tSec > dur) continue;

    const bi        = Math.min(Math.floor((tSec / dur) * rms.length), rms.length - 1);
    const amp       = rms[bi] * scale;                    // 0..1 normalised
    const barH      = Math.max(1, amp * h * 0.92);        // pixel height
    const isPast    = px < cx;
    const distFrac  = Math.abs(px - cx) / cx;             // 0=head, 1=edge

    // Brightness gradient: full at playhead, fades to edges
    const brightness = isPast
      ? 0.22 + (1 - distFrac) * 0.28    // played: 22–50%
      : 0.50 + (1 - distFrac) * 0.50;   // upcoming: 50–100%

    // Amplitude heat: loud bars shift toward white
    const heat  = Math.min(1, amp * 1.4);
    const r     = Math.round(colorR + (255 - colorR) * heat * 0.55);
    const g     = Math.round(colorG + (255 - colorG) * heat * 0.25);
    const b     = Math.round(colorB + (255 - colorB) * heat * 0.08);
    const alpha = Math.round(brightness * 255).toString(16).padStart(2,'0');
    const fill  = `rgb(${r},${g},${b})${alpha}`;

    // ── Top canvas: bars grow DOWN from centre line (bottom of top half) ──
    ctx.fillStyle = fill;
    ctx.fillRect(px, h - barH, 1, barH);

    // ── Bottom canvas (mirror via CSS scaleY(-1)): same bars drawn same way ──
    // CSS handles the flip — just draw identically
    if(ctx2){
      ctx2.fillStyle = fill;
      ctx2.fillRect(px, h - barH, 1, barH);
    }
  }

  // ── Time labels on top canvas ──
  ctx.font      = '7px Courier New';
  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.fillText(fmtDur(pos), 4, h - 3);
  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(255,255,255,0.3)';
  ctx.fillText('-' + fmtDur(Math.max(0, dur - pos)), w - 4, h - 3);
}


function animateWavestrips(){
  waveRAF = requestAnimationFrame(animateWavestrips);

  // Deck A — renderWaveCanvas sizes both canvases internally
  const canvA = document.getElementById('waveStripA');
  if(canvA){
    const audioA = (STATE.playing || STATE.paused) ? masterAudio : null;
    renderWaveCanvas('A', canvA, audioA, STATE.playing);
  }

  // Deck B
  const canvB = document.getElementById('waveStripB');
  if(canvB){
    const audioB = (deckState.B.playing || (deckBAudio && deckBAudio.currentTime > 0)) ? deckBAudio : null;
    renderWaveCanvas('B', canvB, audioB, deckState.B.playing);
  }
}

// drawWaveFrame kept for backward compat (called from doRestart)
function drawWaveFrame(deck, canvas, color, frac, alpha){
  drawEmptyWave(canvas, color);
}

function getAngle(e,el){const r=el.getBoundingClientRect(),cx=r.left+r.width/2,cy=r.top+r.height/2;return Math.atan2(e.clientY-cy,e.clientX-cx);}
function getTouchAngle(e,el){const t=e.touches[0];return getAngle(t,el);}
function angleDiff(a,b){let d=a-b;while(d>Math.PI)d-=2*Math.PI;while(d<-Math.PI)d+=2*Math.PI;return d;}

// ─── RANDOMIZER ───────────────────────────────────────
function openRandomizer(){
  const sel=document.getElementById('randSource'); if(!sel) return;
  sel.innerHTML='<option value="all">All Loaded Folders</option>';
  STATE.folders.forEach(f=>{const o=document.createElement('option');o.value=f.id;o.textContent=f.name;sel.appendChild(o);});
  document.getElementById('randPreview').textContent='Click "Preview" to see what will be added.';
  openModal('randomizerModal');
}
function getRandomizerPool(){
  const src=document.getElementById('randSource')?.value,genre=document.getElementById('randGenre')?.value;
  return STATE.fileLibrary.filter(f=>{if(src&&src!=='all'&&f.folderId!==src)return false;if(genre&&f.genre!==genre)return false;return f.duration!==null;});
}
function calcTargetSec(){const v=(document.getElementById('randDuration')?.value||'0:30:00').split(':').map(Number);if(v.length===3)return v[0]*3600+v[1]*60+v[2];if(v.length===2)return v[0]*60+v[1];return 1800;}
function buildRandomSet(pool,target){const sh=[...pool].sort(()=>Math.random()-0.5);const songs=[];let t=0;for(const f of sh){if(t>=target)break;songs.push(f);t+=f.duration||0;}return{songs,totalSec:t};}
function previewRandomize(){
  const pool=getRandomizerPool(); if(!pool.length){document.getElementById('randPreview').textContent='No files available.';return;}
  const{songs,totalSec}=buildRandomSet(pool,calcTargetSec());
  document.getElementById('randPreview').innerHTML=`<strong style="color:var(--green)">${songs.length} songs</strong> — Total: <strong>${fmtDur(totalSec)}</strong><br><span style="color:var(--text3);font-size:8px;">${songs.slice(0,5).map(s=>`${s.artist} – ${s.title}`).join('<br>')}${songs.length>5?'<br>...and '+(songs.length-5)+' more':''}</span>`;
}
function doRandomize(){
  const pool=getRandomizerPool(); if(!pool.length){alert('No files available.');return;}
  const{songs}=buildRandomSet(pool,calcTargetSec());
  const mode=document.querySelector('input[name="randMode"]:checked')?.value||'append';
  if(mode==='replace') clearPlaylist();
  songs.forEach(f=>addToPlaylist({id:'pl_rand_'+Date.now()+'_'+Math.random(),artist:f.artist,title:f.title||f.name,duration:f.duration,fileObj:f.fileObj,type:'file',bpm:f.bpm,genre:f.genre,url:null}));
  closeModal('randomizerModal');
  addLog('system',`Randomized: ${songs.length} songs`,fmtDur(songs.reduce((s,f)=>s+(f.duration||0),0)));
}

// ─── SAMPLER ──────────────────────────────────────────
function toggleSampler(){
  STATE.samplerOpen=!STATE.samplerOpen;
  document.getElementById('samplerPanel')?.classList.toggle('open',STATE.samplerOpen);
  document.getElementById('bbSamplerBtn')?.classList.toggle('open',STATE.samplerOpen);
  const btn=document.getElementById('bbSamplerBtn');
  if(btn) btn.textContent=STATE.samplerOpen?'🎛 SAMPLER ◀':'🎛 SAMPLER ▶';
  if(STATE.samplerOpen) initPlatters();
}
function closeSampler(){STATE.samplerOpen=false;document.getElementById('samplerPanel')?.classList.remove('open');const btn=document.getElementById('bbSamplerBtn');if(btn){btn.classList.remove('open');btn.textContent='🎛 SAMPLER ▶';}}
function showSamplerTab(tab){
  STATE.activeSamplerTab=tab;
  document.querySelectorAll('.sampler-tab').forEach((el,i)=>el.classList.toggle('on',['lyrics','instants','swvol','log'][i]===tab));
  ['lyricsView','instantsView','swvolView','logView'].forEach((id,i)=>{const el=document.getElementById(id);if(el)el.className=id.replace('View','-view')+(tab===['lyrics','instants','swvol','log'][i]?' active':'');});
  const sw=document.getElementById('swTransport'); if(sw) sw.style.display=tab==='instants'?'flex':'none';
  if(tab==='log') renderLog();
  if(tab==='swvol') renderSwVolPanel();
  if(tab==='instants') renderSwGrid();
  // Auto-fetch lyrics when switching to lyrics tab if no lyrics loaded
  if(tab==='lyrics'){
    const item=STATE.playlist[STATE.nowPlayingIdx];
    if(item){
      const key=lyricsKey(item);
      if(!lyricsStore[key]?.lines?.length){
        // Small delay so the tab animation completes first
        setTimeout(()=>autoFetchLyrics(false),400);
      }
    }
  }
}

// Sweeper banks
function renderBankTabs(){
  const row=document.getElementById('swBankRow'); if(!row) return;
  row.innerHTML='';
  STATE.swBanks.forEach((bank,i)=>{
    const el=document.createElement('div');
    el.className='sw-bank-tab'+(i===STATE.activeBankIdx?' on':'');
    el.textContent=bank.name;
    el.onclick=()=>{STATE.activeBankIdx=i;renderBankTabs();renderSwGrid();updateActiveBankTitle();};
    el.oncontextmenu=e=>{e.preventDefault();showBankCtx(e,i);};
    row.appendChild(el);
  });
  const addBtn=document.createElement('div');
  addBtn.className='sw-add-bank';addBtn.textContent='＋ New Bank';addBtn.onclick=addNewBank;
  row.appendChild(addBtn);
  updateActiveBankTitle();
}
function updateActiveBankTitle(){const b=STATE.swBanks[STATE.activeBankIdx];const el=document.getElementById('activeBankName');if(el)el.textContent=b?b.name:'No banks — click + New Bank';}
function addNewBank(){document.getElementById('bankNameTitle').textContent='New Bank';document.getElementById('bankNameInput').value='';window._bankEditIdx=-1;openModal('bankNameModal');}
let _bankEditIdx=-1;
function showBankCtx(e,idx){_bankEditIdx=idx;const m=document.getElementById('ctxMenu');if(m){m.style.left=e.clientX+'px';m.style.top=e.clientY+'px';m.classList.add('open');}}
document.addEventListener('click',()=>document.getElementById('ctxMenu')?.classList.remove('open'));
function ctxAction(action){
  if(action==='rename'){const b=STATE.swBanks[_bankEditIdx];if(!b)return;document.getElementById('bankNameTitle').textContent='Rename Bank';document.getElementById('bankNameInput').value=b.name;window._bankEditIdx=_bankEditIdx;openModal('bankNameModal');}
  else if(action==='delete'){if(confirm(`Delete "${STATE.swBanks[_bankEditIdx]?.name}"?`)){STATE.swBanks.splice(_bankEditIdx,1);STATE.activeBankIdx=Math.max(0,STATE.activeBankIdx-1);renderBankTabs();renderSwGrid();}}
}
function confirmBankName(){
  const name=document.getElementById('bankNameInput')?.value.trim(); if(!name) return;
  const ei=window._bankEditIdx;
  if(ei>=0&&STATE.swBanks[ei]) STATE.swBanks[ei].name=name;
  else{STATE.swBanks.push({id:'bank_'+Date.now(),name,pads:[]});STATE.activeBankIdx=STATE.swBanks.length-1;}
  closeModal('bankNameModal'); renderBankTabs(); renderSwGrid(); saveSwBanks();
}
function renderSwGrid(){
  const bank=STATE.swBanks[STATE.activeBankIdx];
  const grid=document.getElementById('swGrid'); if(!grid) return;
  if(!bank){grid.innerHTML='<div style="padding:12px;color:var(--text3);font-size:9px;">Create a bank with + New Bank</div>';return;}
  const pads=[...bank.pads,null];
  grid.innerHTML=pads.map((pad,i)=>{
    if(!pad) return `<div class="sw-pad empty" oncontextmenu="padRightClick(event,${i})"><span class="sw-pad-add-hint">＋</span><span style="font-size:7px;color:var(--text3)">right-click</span></div>`;
    const ip=STATE.playingPadIdx===i;
    return `<div class="sw-pad ${ip?'playing':''}" style="background:${pad.color}22;border-color:${pad.color}66;color:${pad.color};" onclick="playPad(${i})" oncontextmenu="padRightClick(event,${i})"><span class="sw-pad-name">${escHtml(pad.title||'—')}</span><span class="sw-pad-dur">${pad.duration?fmtDur(pad.duration):''}</span></div>`;
  }).join('');
}
function padRightClick(e,idx){e.preventDefault();e.stopPropagation();openPadEditor(idx);}
// Sweeper duck state
let sweeperDuckInterval=null;
const SWEEPER_DUCK_TARGET=0.20; // music ducks to 20% while sweeper plays
const SWEEPER_DUCK_ATTACK=0.15; // seconds to duck
const SWEEPER_DUCK_RELEASE=0.4; // seconds to restore

function playPad(idx){
  const bank=STATE.swBanks[STATE.activeBankIdx]; if(!bank) return;
  const pad=bank.pads[idx]; if(!pad||!pad.fileObj) return;
  const key=STATE.activeBankIdx+'_'+idx;
  // Toggle: clicking same pad again stops it
  if(STATE.playingPadIdx===idx){ stopCurrentPad(); return; }
  if(STATE.playingPadIdx>=0) stopCurrentPad();
  STATE.playingPadIdx=idx;
  if(!swAudioPool[key]){ swAudioPool[key]=new Audio(); swAudioPool[key].src=URL.createObjectURL(pad.fileObj); }
  const audio=swAudioPool[key];
  audio.volume=(pad.volume||100)/100*(faderState.sampler/100);
  audio.currentTime=(pad.startMs||0)/1000;
  audio.play().catch(()=>{});
  // Duck the music underneath (Jazler-style sweeper overlap)
  sweeperDuckMusic(true);
  audio.onended=()=>{
    STATE.playingPadIdx=-1;
    sweeperDuckMusic(false);
    renderSwGrid();
    addLog('sweeper',pad.title||'—',fmtDur(pad.duration||0));
  };
  renderSwGrid();
}

function sweeperDuckMusic(duck){
  if(!masterGain||!audioCtx) return;
  // Don't interfere if mic ducking is already active
  if(micActive) return;
  const t=audioCtx.currentTime;
  const musicLevel=faderState.music/100;
  if(duck){
    masterGain.gain.cancelScheduledValues(t);
    masterGain.gain.setTargetAtTime(musicLevel*SWEEPER_DUCK_TARGET, t, SWEEPER_DUCK_ATTACK);
  } else {
    masterGain.gain.cancelScheduledValues(t);
    masterGain.gain.setTargetAtTime(musicLevel, t, SWEEPER_DUCK_RELEASE);
  }
}

function stopCurrentPad(){
  if(STATE.playingPadIdx<0) return;
  const k=STATE.activeBankIdx+'_'+STATE.playingPadIdx;
  if(swAudioPool[k]){ swAudioPool[k].pause(); swAudioPool[k].currentTime=0; }
  STATE.playingPadIdx=-1;
  sweeperDuckMusic(false);
  renderSwGrid();
}
function swStop(){stopCurrentPad();}
function toggleAutoGain(){STATE.swAutoGain=!STATE.swAutoGain;document.getElementById('swAgBtn')?.classList.toggle('active',STATE.swAutoGain);}
function toggleFadeMix(){STATE.swFadeMix=!STATE.swFadeMix;document.getElementById('swFmBtn')?.classList.toggle('active',STATE.swFadeMix);}
let selectedPadGridIdx=-1;
function swNavPrev(){const b=STATE.swBanks[STATE.activeBankIdx];if(!b||!b.pads.length)return;selectedPadGridIdx=Math.max(0,(selectedPadGridIdx<=0?b.pads.length:selectedPadGridIdx)-1);highlightPadSelect();}
function swNavNext(){const b=STATE.swBanks[STATE.activeBankIdx];if(!b||!b.pads.length)return;selectedPadGridIdx=(selectedPadGridIdx+1)%b.pads.length;highlightPadSelect();}
function highlightPadSelect(){document.querySelectorAll('.sw-pad').forEach((el,i)=>{el.style.outline=i===selectedPadGridIdx?'2px solid var(--yellow)':'';}); }

// Pad editor
const PAD_COLORS_SW=['#ff4040','#ff7a00','#ffcc00','#00e05a','#3a8fff','#9b59b6','#ff6b9d','#00ccaa','#ffffff','#888888'];
let editingPadIdx=-1,padPreviewAudio=null;

function initColorPicker(){
  const grid=document.getElementById('padColorPicker'); if(!grid) return;
  grid.innerHTML=PAD_COLORS_SW.map((c,i)=>`<div class="color-swatch ${i===0?'selected':''}" style="background:${c}" data-color="${c}" onclick="selectPadColor('${c}',this)"></div>`).join('');
}
function selectPadColor(color,el){document.querySelectorAll('.color-swatch').forEach(s=>s.classList.remove('selected'));el.classList.add('selected');}
function openPadEditor(padIdx){
  editingPadIdx=padIdx;
  const bank=STATE.swBanks[STATE.activeBankIdx],pad=bank?.pads[padIdx];
  const s=id=>document.getElementById(id);
  if(s('padEditTitle')) s('padEditTitle').textContent=pad?'Edit Pad':'New Pad';
  if(s('padFilePath')) s('padFilePath').value=pad?.fileObj?.name||'';
  if(s('padTitle'))    s('padTitle').value=pad?.title||'';
  if(s('padVolume'))   s('padVolume').value=pad?.volume||100;
  if(s('padVolumeVal')) s('padVolumeVal').textContent=(pad?.volume||100)+'%';
  if(s('padStartMs'))  s('padStartMs').value=pad?.startMs||0;
  if(s('padMixTimeMs'))s('padMixTimeMs').value=pad?.mixTimeMs||0;
  if(s('padDeleteBtn')) s('padDeleteBtn').style.display=pad?'block':'none';
  if(s('padProgFill')) s('padProgFill').style.width='0%';
  if(s('padTimeDisplay')) s('padTimeDisplay').textContent='0:00 / 0:00';
  initColorPicker();
  if(pad?.color) document.querySelectorAll('.color-swatch').forEach(sw=>sw.classList.toggle('selected',sw.dataset.color===pad.color));
  if(padPreviewAudio){padPreviewAudio.pause();padPreviewAudio=null;}
  openModal('padEditModal');
}
function pickPadFile(){document.getElementById('padFilePicker')?.click();}
function onPadFilePicked(input){
  const file=input.files[0]; if(!file) return;
  const fp=document.getElementById('padFilePath');if(fp)fp.value=file.name;
  const pt=document.getElementById('padTitle');if(pt&&!pt.value)pt.value=file.name.replace(/\.[^/.]+$/,'');
  padPreviewAudio=new Audio(URL.createObjectURL(file));
  padPreviewAudio._fileObj=file;
  padPreviewAudio.addEventListener('loadedmetadata',()=>{const td=document.getElementById('padTimeDisplay');if(td)td.textContent=`0:00 / ${fmtDur(padPreviewAudio.duration)}`;});
  padPreviewAudio.addEventListener('timeupdate',()=>{const pct=(padPreviewAudio.currentTime/padPreviewAudio.duration)*100||0;const pf=document.getElementById('padProgFill');if(pf)pf.style.width=pct+'%';const td=document.getElementById('padTimeDisplay');if(td)td.textContent=`${fmtDur(padPreviewAudio.currentTime)} / ${fmtDur(padPreviewAudio.duration)}`;});
  input.value='';
}
function padPreviewPlay(){padPreviewAudio?.play().catch(()=>{});}
function padPreviewStop(){if(padPreviewAudio){padPreviewAudio.pause();padPreviewAudio.currentTime=0;}}
function savePad(){
  const bank=STATE.swBanks[STATE.activeBankIdx]; if(!bank) return;
  const title=document.getElementById('padTitle')?.value.trim()||'Pad';
  const color=document.querySelector('.color-swatch.selected')?.dataset.color||'#3a8fff';
  const volume=parseInt(document.getElementById('padVolume')?.value)||100;
  const startMs=parseInt(document.getElementById('padStartMs')?.value)||0;
  const mixTimeMs=parseInt(document.getElementById('padMixTimeMs')?.value)||0;
  const fileObj=padPreviewAudio?._fileObj||(bank.pads[editingPadIdx]?.fileObj)||null;
  const duration=padPreviewAudio?.duration||(bank.pads[editingPadIdx]?.duration)||null;
  const np={title,color,volume,startMs,mixTimeMs,fileObj,duration};
  if(editingPadIdx>=0&&editingPadIdx<bank.pads.length) bank.pads[editingPadIdx]=np;
  else{bank.pads.push(np);delete swAudioPool[STATE.activeBankIdx+'_'+(bank.pads.length-1)];}
  closeModal('padEditModal'); renderSwGrid(); updateSwVolPanel(); saveSwBanks();
}
function deletePad(){const bank=STATE.swBanks[STATE.activeBankIdx];if(!bank||editingPadIdx<0)return;bank.pads.splice(editingPadIdx,1);closeModal('padEditModal');renderSwGrid();updateSwVolPanel();saveSwBanks();}
function updateSwVolPanel(){
  const scroll=document.getElementById('swVolScroll'); if(!scroll) return;
  const all=[];STATE.swBanks.forEach(bank=>bank.pads.forEach(pad=>all.push({bank:bank.name,pad})));
  if(!all.length){scroll.innerHTML='<div class="fi-loading">No sweeper pads configured.</div>';return;}
  scroll.innerHTML=all.map((item,i)=>`<div class="sv-item"><div class="sv-name" style="color:${item.pad.color}">[${item.bank}] ${escHtml(item.pad.title)}</div><div class="sv-slider-wrap"><input class="sv-slider" type="range" min="0" max="100" value="${item.pad.volume||100}" oninput="updatePadVol(${i},this.value,this.nextElementSibling)"><span class="sv-val">${item.pad.volume||100}%</span></div></div>`).join('');
}
function renderSwVolPanel(){updateSwVolPanel();}
function updatePadVol(allIdx,val,el){if(el)el.textContent=val+'%';let idx=0;for(const bank of STATE.swBanks)for(const pad of bank.pads){if(idx===allIdx){pad.volume=parseInt(val);return;}idx++;}}

// Persist per-track BPM, intro, outro by filename
function saveTrackMeta(){
  try{
    const meta={};
    STATE.fileLibrary.forEach(f=>{
      if(f.bpm||f.introSec!=null||f.outroSec!=null)
        meta[f.name]={bpm:f.bpm||null,introSec:f.introSec??null,outroSec:f.outroSec??null};
    });
    if(Object.keys(meta).length) localStorage.setItem('bpfm_trackmeta',JSON.stringify(meta));
  }catch(e){}
}
function loadTrackMeta(){
  try{
    const raw=localStorage.getItem('bpfm_trackmeta'); if(!raw) return;
    const meta=JSON.parse(raw);
    STATE.fileLibrary.forEach(f=>{
      const m=meta[f.name]; if(!m) return;
      if(m.bpm!=null)      f.bpm=m.bpm;
      if(m.introSec!=null) f.introSec=m.introSec;
      if(m.outroSec!=null) f.outroSec=m.outroSec;
    });
  }catch(e){}
}
function saveSwBanks(){try{localStorage.setItem('bpfm_banks',JSON.stringify(STATE.swBanks.map(b=>({...b,pads:b.pads.map(p=>({...p,fileObj:null}))}))));}catch(e){}}
function loadSwBanks(){try{const raw=localStorage.getItem('bpfm_banks');if(raw){const d=JSON.parse(raw);STATE.swBanks=d.map(b=>({...b,pads:b.pads.map(p=>({...p,fileObj:null}))}));}}catch(e){}}

// ─── LYRICS ───────────────────────────────────────────
// ─── LYRICS ENGINE ────────────────────────────────────
// Per-track LRC storage: keyed by "artist|||title"
const lyricsStore={};
let lyricsCurrentKey=null;

function lyricsKey(item){
  if(!item) return null;
  return (item.artist||'').toLowerCase().trim()+'|||'+(item.title||'').toLowerCase().trim();
}

// Parse .lrc file text into [{t:seconds, text:string}]
function parseLRC(raw){
  const lines=raw.split(/\r?\n/);
  const parsed=[];
  const timeRx=/\[(\d{1,3}):(\d{2}(?:\.\d+)?)\]/g;
  const metaRx=/^\[(?:ti|ar|al|by|offset|length|re|ve):/i;
  lines.forEach(line=>{
    if(metaRx.test(line)) return; // skip metadata tags
    let match, times=[], text=line.replace(timeRx,(m,mm,ss)=>{times.push(parseInt(mm)*60+parseFloat(ss));return '';}).trim();
    times.forEach(t=>{ if(text) parsed.push({t,text}); });
  });
  parsed.sort((a,b)=>a.t-b.t);
  return parsed;
}

// Render lyrics panel for current track
function renderLyrics(title,artist){
  const sc=document.getElementById('lyricsScroll');
  const dropZone=document.getElementById('lrcDropZone');
  const lbl=document.getElementById('lyrSourceLbl');
  if(!sc) return;

  const item=STATE.playlist[STATE.nowPlayingIdx];
  const key=lyricsKey(item);
  lyricsCurrentKey=key;

  // Update header
  const st=document.getElementById('lyricsSongTitle');
  const sa=document.getElementById('lyricsArtist');
  if(st) st.textContent=title||'No track';
  if(sa) sa.textContent=artist||'';

  // Check store
  const data=key?lyricsStore[key]:null;

  if(data && data.lines && data.lines.length){
    dropZone && (dropZone.style.display='none');
    sc.style.display='';
    if(lbl){ lbl.textContent='● LRC synced'; lbl.className='lyr-source-lbl lrc'; }
    sc.innerHTML=data.lines.map((l,i)=>
      `<div class="lyric-line" data-t="${l.t}" data-idx="${i}">${escHtml(l.text)}</div>`
    ).join('');
  } else {
    // Show drop zone + no-lyrics message
    dropZone && (dropZone.style.display='block');
    sc.style.display='';
    if(lbl){ lbl.textContent='no lyrics'; lbl.className='lyr-source-lbl'; }
    const q=encodeURIComponent((artist||'')+' '+(title||'')+' lyrics');
    const ddgUrl='https://duckduckgo.com/?q='+q+'&ia=web';
    sc.innerHTML=`<div class="lyrics-no-data">
      No lyrics loaded for this track.<br><br>
      <a onclick="lyricsSearchWeb()">🔍 Search "${escHtml((artist||title||'').substring(0,30))}" lyrics online</a><br><br>
      <span style="color:var(--text3);font-size:9px;">
        Load a <strong>.lrc file</strong> for synced display,<br>
        or drag one onto the drop zone above.
      </span>
    </div>`;
  }
}

// Open web lyrics search in new tab
function lyricsSearchWeb(){
  const item=STATE.playlist[STATE.nowPlayingIdx];
  const artist=item?.artist||document.getElementById('lyricsArtist')?.textContent||'';
  const title=item?.title||document.getElementById('lyricsSongTitle')?.textContent||'';
  if(!artist&&!title){ showToast('No track playing'); return; }
  const q=encodeURIComponent(artist+' '+title+' lyrics');
  // Open Google lyrics search (best source for lyrics knowledge panels)
  window.open('https://www.google.com/search?q='+q,'_blank','noopener');
  // Also show DuckDuckGo inside the lyrics scroll as an iframe-friendly fallback
  const sc=document.getElementById('lyricsScroll');
  if(sc){
    const ddg='https://duckduckgo.com/?q='+q+'&ia=web';
    sc.innerHTML=`<div style="padding:8px 6px;font-size:9px;color:var(--text3);">
      Opened Google search in new tab.<br>
      <a href="${ddg}" target="_blank" rel="noopener" style="color:var(--blue);">Also open DuckDuckGo</a>
      <span style="margin-left:8px;color:var(--text3);">— or load a .lrc file for synced display</span>
    </div>`;
  }
  addLog('system','Lyrics search: '+artist+' – '+title,'—');
}

// Pick .lrc file from disk
function lyricsPickLRC(){
  document.getElementById('lrcFilePicker')?.click();
}

// File picker change
function onLRCFilePicked(input){
  const file=input.files[0]; if(!file) return;
  const reader=new FileReader();
  reader.onload=e=>storeLRC(e.target.result, file.name);
  reader.readAsText(file);
  input.value='';
}

// Drag-drop .lrc onto lyrics panel
function onLRCDrop(e){
  e.preventDefault();
  document.getElementById('lrcDropZone')?.classList.remove('drag-over');
  const file=Array.from(e.dataTransfer.files).find(f=>/\.(lrc|txt)$/i.test(f.name));
  if(!file){ showToast('Drop a .lrc file'); return; }
  const reader=new FileReader();
  reader.onload=ev=>storeLRC(ev.target.result, file.name);
  reader.readAsText(file);
}

// Store parsed LRC data and re-render
function storeLRC(rawText, filename){
  const lines=parseLRC(rawText);
  if(!lines.length){ showToast('No timestamped lyrics found in file — check it is a valid .lrc'); return; }
  const item=STATE.playlist[STATE.nowPlayingIdx];
  const key=lyricsCurrentKey || lyricsKey(item) || filename.replace(/\.lrc$/i,'');
  lyricsStore[key]={lines, source:'lrc', file:filename};
  if(item) lyricsCurrentKey=key;
  renderLyrics(item?.title||filename, item?.artist||'');
  showToast('Lyrics loaded: '+lines.length+' lines from '+filename);
  addLog('system','LRC loaded: '+filename, lines.length+' lines');
}

// Clear lyrics for current track
function lyricsClearCurrent(){
  if(lyricsCurrentKey && lyricsStore[lyricsCurrentKey]){
    delete lyricsStore[lyricsCurrentKey];
    const item=STATE.playlist[STATE.nowPlayingIdx];
    renderLyrics(item?.title, item?.artist);
    showToast('Lyrics cleared');
  }
}

// Highlight active lyric line based on playback position
function updateLyricsHighlight(){
  if(!STATE.playing && !STATE.paused) return;
  const lines=document.querySelectorAll('#lyricsScroll .lyric-line');
  if(!lines.length) return;

  // Use masterAudio.currentTime directly — more accurate than STATE.posSec
  // Subtract a small look-ahead offset: LRC timestamps mark line START,
  // so we wait until we're clearly past the cue before flipping.
  // 0.35s offset corrects the "one line ahead" issue from lrclib timestamps.
  const pos = (masterAudio?.currentTime ?? STATE.posSec) - 0.35;

  let ai = -1;
  lines.forEach((el, i)=>{
    if(parseFloat(el.dataset.t || 0) <= pos) ai = i;
  });

  lines.forEach((el, i)=>{
    const want = i===ai ? 'lyric-line active'
               : i<ai  ? 'lyric-line past'
               :          'lyric-line';
    if(el.className !== want) el.className = want;
    if(i===ai) el.scrollIntoView({behavior:'smooth', block:'center'});
  });
}

// Click a lyric line to seek audio
document.addEventListener('click',e=>{
  const line=e.target.closest('.lyric-line');
  if(!line) return;
  const t=parseFloat(line.dataset.t);
  if(!isNaN(t)&&masterAudio&&STATE.durSec){
    masterAudio.currentTime=t;
  }
});

// ─── PLAY LOG ─────────────────────────────────────────
const playLog=[];
function addLog(type,title,dur){playLog.unshift({type,title,dur,time:new Date().toTimeString().slice(0,8)});if(playLog.length>500)playLog.pop();}
function renderLog(){
  const el=document.getElementById('logScroll'); if(!el) return;
  if(!playLog.length){el.innerHTML='<div class="fi-loading">No entries yet.</div>';return;}
  el.innerHTML=playLog.map(e=>`<div class="log-entry"><span class="log-time">${e.time}</span><span class="log-badge lt-${e.type}">${e.type.toUpperCase()}</span><span class="log-title">${escHtml(e.title)}</span><span class="log-dur">${e.dur}</span></div>`).join('');
}

// ─── MODALS ───────────────────────────────────────────
function openModal(id){document.getElementById(id)?.classList.add('open');}
function closeModal(id){document.getElementById(id)?.classList.remove('open');}
document.querySelectorAll('.modal-overlay').forEach(el=>{el.addEventListener('click',function(e){if(e.target===this)this.classList.remove('open');});});

// ─── KEYBOARD ─────────────────────────────────────────
// F/B panel shortcuts (only when not typing in an input)
document.addEventListener('keydown', kbShortcut);
function kbShortcut(e){
  if(e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA') return;
  if(e.key==='f'||e.key==='F'){ showFilePanel(); }
  else if(e.key==='b'||e.key==='B'){ showBrowserPanel(); }
}
document.addEventListener('keydown',e=>{
  const tag=e.target.tagName;
  if(tag==='INPUT'||tag==='TEXTAREA'||tag==='SELECT'||e.target.isContentEditable) return;
  // Also ignore if focus is inside an iframe (browser panel)
  if(document.activeElement?.tagName==='IFRAME') return;
  switch(e.code){
    case 'Space': e.preventDefault(); masterPlay(); break;
    case 'KeyN':  doSkipNext(); break;
    case 'KeyR':  doRestart(); break;
    case 'KeyL':  doToggleLoop(); break;
    case 'Escape':masterStop(); break;
    case 'KeyA':  setActionMode('ADD'); break;
    case 'KeyI':  setActionMode('INSERT'); break;
    case 'KeyD':  setActionMode('DELETE'); break;
    case 'ArrowLeft':  if(masterAudio)masterAudio.currentTime=Math.max(0,masterAudio.currentTime-5);break;
    case 'ArrowRight': if(masterAudio)masterAudio.currentTime=Math.min(STATE.durSec,masterAudio.currentTime+5);break;
  }
});

// ─── UTILS ────────────────────────────────────────────
function fmtDur(sec){
  if(!sec||isNaN(sec))return'0:00';
  sec=Math.floor(sec);const h=Math.floor(sec/3600),m=Math.floor((sec%3600)/60),s=sec%60;
  if(h>0)return`${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return`${m}:${String(s).padStart(2,'0')}`;
}
function escHtml(str){if(!str)return'';return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}

// ─── SCRATCH FX ───────────────────────────────────────
const scrState = {
  A:{ mode:'scratch', dragging:false, lastX:0 },
  B:{ mode:'scratch', dragging:false, lastX:0 }
};

function toggleScratch(deck) {
  const el = document.getElementById('scratchDeck'+deck);
  if (!el) return;
  el.classList.toggle('open');
}

function setScrMode(deck, mode) {
  scrState[deck].mode = mode;
  ['scratch','nudge','pitch','brake'].forEach(m => {
    const btn = document.getElementById(`scrM${deck}_${m}`);
    if (btn) btn.classList.toggle('on', m === mode);
  });
}

function startScr(deck, e) {
  e.preventDefault();
  const s = scrState[deck];
  s.dragging = true;
  s.lastX = e.clientX ?? e.touches?.[0]?.clientX ?? 0;
  const pad = document.getElementById('scrPad'+deck);
  if (pad) pad.classList.add('going');
  const onMove = ev => {
    if (!s.dragging) return;
    const cx = ev.clientX ?? ev.touches?.[0]?.clientX ?? 0;
    const dx = cx - s.lastX; s.lastX = cx;
    const ww = document.getElementById('waveWrap'+deck);
    if (ww) { ww.style.filter = `hue-rotate(${dx*4}deg) brightness(1.4)`; setTimeout(()=>{ if(ww) ww.style.filter=''; }, 80); }
  };
  const onUp = () => {
    s.dragging = false;
    const pad = document.getElementById('scrPad'+deck);
    if (pad) pad.classList.remove('going');
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.removeEventListener('touchmove', onMove);
    document.removeEventListener('touchend', onUp);
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
  document.addEventListener('touchmove', onMove, {passive:false});
  document.addEventListener('touchend', onUp);
}

function doScrFX(deck, fx) {
  const ww = document.getElementById('waveWrap'+deck);
  const pad = document.getElementById('scrPad'+deck);
  if (pad) { pad.style.boxShadow='0 0 14px rgba(255,122,0,0.5)'; setTimeout(()=>pad.style.boxShadow='',300); }
  const effects = {
    baby:      ()=>{ if(ww){ww.style.filter='hue-rotate(180deg) brightness(1.5)'; setTimeout(()=>ww.style.filter='',200);} },
    tear:      ()=>{ if(ww){ww.style.filter='saturate(4) brightness(1.4)'; setTimeout(()=>ww.style.filter='',150);} },
    flare:     ()=>{ if(ww){ww.style.filter='invert(0.3) brightness(2)'; setTimeout(()=>ww.style.filter='',250);} },
    crab:      ()=>{ let t=0; const iv=setInterval(()=>{ if(ww) ww.style.filter=t%2?'brightness(2) hue-rotate(60deg)':'brightness(1)'; if(++t>6){clearInterval(iv);if(ww)ww.style.filter='';} },60); },
    echo:      ()=>{ let t=0; const iv=setInterval(()=>{ if(ww) ww.style.filter=t%2?'brightness(1.4) blur(1px)':'brightness(1)'; if(++t>8){clearInterval(iv);if(ww)ww.style.filter='';} },100); },
    reverse:   ()=>{ if(ww){ww.style.transform='scaleX(-1)'; setTimeout(()=>ww.style.transform='',400);} },
    spinup:    ()=>{ if(ww){ww.style.filter='brightness(2.5) saturate(3)'; setTimeout(()=>ww.style.filter='',500);} },
    brake_fx:  ()=>{ if(ww){ww.style.filter='grayscale(1) brightness(0.6)'; setTimeout(()=>ww.style.filter='',600);} },
    chirp:     ()=>{ let t=0; const iv=setInterval(()=>{ if(ww) ww.style.filter=`hue-rotate(${t*40}deg)`; if(++t>8){clearInterval(iv);if(ww)ww.style.filter='';} },50); },
    orbit:     ()=>{ let t=0; const iv=setInterval(()=>{ if(ww) ww.style.filter=`hue-rotate(${t*30}deg) brightness(${1+Math.sin(t)*0.4})`; if(++t>12){clearInterval(iv);if(ww)ww.style.filter='';} },60); },
    hydroplane:()=>{ if(ww){ww.style.filter='blur(2px) brightness(1.8)'; setTimeout(()=>ww.style.filter='',350);} },
    stab:      ()=>{ if(ww){ww.style.filter='brightness(3) contrast(2)'; setTimeout(()=>ww.style.filter='',120);} },
  };
  effects[fx]?.();
  addLog('system', `[Deck ${deck}] Scratch: ${fx}`, '—');
}

// ─── MIX POINTS ───────────────────────────────────────
function editMixPoint(idx, type){
  const item=STATE.playlist[idx]; if(!item) return;
  // Use current playback position if this track is playing, else prompt
  let currentPos=null;
  if(idx===STATE.nowPlayingIdx && masterAudio){
    currentPos=masterAudio.currentTime;
  }
  const current = type==='intro' ? item.introSec : item.outroSec;
  const label = type==='intro'
    ? 'Set INTRO cue (seconds from start — where music/vocals begin):'
    : 'Set OUTRO cue (seconds from start — where next song can fade in):';
  const defaultVal = current!=null ? current.toFixed(1)
                   : (currentPos!=null ? currentPos.toFixed(1)
                   : (type==='intro'?'0':''));
  const val=prompt(label + (currentPos!=null?'\n(current position: '+fmtDur(currentPos)+')':''), defaultVal);
  if(val===null) return;
  const sec=parseFloat(val);
  if(isNaN(sec)||sec<0){ alert('Enter a valid time in seconds.'); return; }
  if(type==='intro') item.introSec=sec;
  else item.outroSec=sec;
  recalcPlaylistTimes();
  renderPlaylist();
  saveTrackMeta();
  addLog('system',`[${type.toUpperCase()}] ${item.artist}: set to ${fmtDur(sec)}`,'—');
  showToast((type==='intro'?'Intro':'Outro')+' set: '+fmtDur(sec));
}

function autoDetectMixPoints(){
  // Rough heuristic: intro=2s, outro=duration-30s
  STATE.playlist.forEach(item=>{
    if(item.duration && item.duration>60){
      if(item.introSec==null) item.introSec=2;
      if(item.outroSec==null) item.outroSec=Math.max(item.duration-30,item.duration*0.85);
    }
  });
  recalcPlaylistTimes(); renderPlaylist();
  showToast('Auto mix-points set for all tracks');
}

// ─── THEME TOGGLE ─────────────────────────────────────
function toggleTheme(){
  const isLight=document.body.classList.toggle('light-mode');
  const btn=document.getElementById('themeToggleBtn');
  const lbl=document.getElementById('themeLbl');
  if(btn) btn.firstChild.textContent=isLight?'☀':'🌙';
  if(lbl) lbl.textContent=isLight?'LIGHT':'DARK';
  try{localStorage.setItem('bpfm_theme',isLight?'light':'dark');}catch(e){}
}
function applyTheme(){
  try{
    const t=localStorage.getItem('bpfm_theme');
    if(t==='light'){
      document.body.classList.add('light-mode');
      const btn=document.getElementById('themeToggleBtn');
      const lbl=document.getElementById('themeLbl');
      if(btn) btn.firstChild.textContent='☀';
      if(lbl) lbl.textContent='LIGHT';
    }
  }catch(e){}
}

// ─── YOUTUBE SEARCH PANEL ─────────────────────────────
// Uses YouTube oEmbed + invidious public API (no API key needed)
const ytSearchCache={};
let ytSearchTimeout=null;

// ─── INTERNET ARCHIVE MUSIC SEARCH ──────────────────────────
// archive.org has CORS-enabled MP3 streams — files route through the full mixer.
// API docs: https://archive.org/advancedsearch.php

const iaSearchCache = {};      // query → search results array
const iaFilesCache  = {};      // identifier → files array

// Search Internet Archive for audio items
async function doYTSearch(){
  const input   = document.getElementById('ytSearchInput');
  const results = document.getElementById('ytSearchResults');
  if(!input || !results) return;

  const q = (input.value||'').trim();
  if(!q){ showToast('Enter a song or artist name'); return; }

  const mediaType = document.getElementById('iaMediaType')?.value || 'audio';
  const format    = document.getElementById('iaFormat')?.value    || 'MP3';
  const cacheKey  = `${q}|${mediaType}|${format}`;

  results.innerHTML = '<div class="yt-search-loading">📼 Searching Internet Archive…</div>';

  if(iaSearchCache[cacheKey]){ iaRenderResults(iaSearchCache[cacheKey]); return; }

  try{
    // Internet Archive Advanced Search API — returns JSONP/JSON with CORS headers
    const url = 'https://archive.org/advancedsearch.php?' + new URLSearchParams({
      q:      `${q} AND mediatype:${mediaType} AND format:${format}`,
      fl:     'identifier,title,creator,description,year,subject,item_size,num_reviews',
      sort:   'downloads desc',
      rows:   20,
      page:   1,
      output: 'json'
    });

    const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if(!resp.ok) throw new Error('Search failed: ' + resp.status);
    const data = await resp.json();

    const docs = data?.response?.docs || [];
    if(!docs.length){
      results.innerHTML = `<div class="yt-search-empty">
        <span style="font-size:20px">📭</span><br><br>
        No results found for <strong>${escHtml(q)}</strong><br>
        <span style="font-size:8px;color:var(--text3);">
          Try different keywords, or change the filter above
        </span><br><br>
        <a onclick="window.open('https://archive.org/search?query=${encodeURIComponent(q)}&and[]=mediatype:audio','_blank','noopener')"
          style="color:var(--blue);cursor:pointer;font-size:8px;">Browse archive.org ↗</a>
      </div>`;
      return;
    }

    iaSearchCache[cacheKey] = docs;
    iaRenderResults(docs, format);

  }catch(err){
    results.innerHTML = `<div class="yt-search-empty">
      ⚠️ Search error: ${escHtml(err.message)}<br><br>
      <a onclick="doYTSearch()" style="color:var(--blue);cursor:pointer;">↺ Retry</a>
    </div>`;
  }
}

// Render search result cards — each item can be expanded to show its audio files
function iaRenderResults(docs, format){
  const results = document.getElementById('ytSearchResults');
  if(!results) return;

  results.innerHTML = docs.map((doc, di)=>{
    const id      = escHtml(doc.identifier||'');
    const title   = escHtml(doc.title||doc.identifier||'Untitled');
    const creator = escHtml(doc.creator||'Unknown artist');
    const year    = doc.year ? escHtml(String(doc.year)) : '';
    const icon    = '📼';

    return `<div class="ia-result-item" id="iaItem_${id}">
      <div class="ia-result-icon">${icon}</div>
      <div class="ia-result-info">
        <div class="ia-result-title" title="${title}">${title}</div>
        <div class="ia-result-creator">${creator}${year?' · '+year:''}</div>
        <div id="iaFiles_${id}" class="ia-result-files">
          <button class="ia-expand-btn" onclick="iaLoadFiles('${id}','iaFiles_${id}',this)">
            ▶ Load tracks…
          </button>
        </div>
      </div>
    </div>`;
  }).join('');
}

// Fetch file list for an item and render individual MP3 rows
async function iaLoadFiles(identifier, containerId, btn){
  if(btn){ btn.textContent = '⏳ Loading…'; btn.disabled = true; }

  // Use cache if available
  if(iaFilesCache[identifier]){
    iaRenderFiles(identifier, containerId, iaFilesCache[identifier]);
    return;
  }

  try{
    const url  = `https://archive.org/metadata/${identifier}/files`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if(!resp.ok) throw new Error(resp.status);
    const data = await resp.json();

    // Filter to audio files only — prefer MP3 > VBR MP3 > OGG, skip mp4/m4a/wav
    const audioExts = ['mp3','ogg','flac','opus'];
    const audioFiles = (data.result||[]).filter(f=>{
      const fmt = (f.format||'').toLowerCase();
      const name = (f.name||'').toLowerCase();
      return audioExts.some(ext => name.endsWith('.'+ext))
          && !name.endsWith('.mp4') && !name.endsWith('.m4a')
          && (fmt.includes('mp3') || fmt.includes('ogg') || fmt.includes('flac') || fmt.includes('opus') || fmt.includes('vbr'));
    });

    // Sort: MP3 first, then by track number if present
    audioFiles.sort((a,b)=>{
      const aIsMP3 = (a.format||'').toLowerCase().includes('mp3');
      const bIsMP3 = (b.format||'').toLowerCase().includes('mp3');
      if(aIsMP3 !== bIsMP3) return aIsMP3 ? -1 : 1;
      const aTrack = parseInt(a.track||a.name||'999');
      const bTrack = parseInt(b.track||b.name||'999');
      return aTrack - bTrack;
    });

    if(!audioFiles.length){
      document.getElementById(containerId).innerHTML =
        '<span style="font-size:8px;color:var(--text3);">No audio files found in this item.</span>';
      return;
    }

    iaFilesCache[identifier] = audioFiles;
    iaRenderFiles(identifier, containerId, audioFiles);

  }catch(err){
    const el = document.getElementById(containerId);
    if(el) el.innerHTML = `<span style="font-size:8px;color:#ff6060;">⚠ ${escHtml(err.message)}</span>
      <button class="ia-expand-btn" onclick="iaLoadFiles('${identifier}','${containerId}',this)">↺ Retry</button>`;
  }
}

function iaRenderFiles(identifier, containerId, files){
  const el = document.getElementById(containerId);
  if(!el) return;

  // Show first 5 by default, expandable
  const MAX_SHOW = 5;
  const show = files.slice(0, MAX_SHOW);
  const rest = files.slice(MAX_SHOW);

  const fileRows = (arr) => arr.map(f=>{
    const streamUrl = `https://archive.org/download/${identifier}/${encodeURIComponent(f.name)}`;
    const safeName  = escHtml(f.name.replace(/\.[^.]+$/, '')); // strip extension
    const safeUrl   = escHtml(streamUrl);
    const safeCreator = escHtml(f.creator||'');
    const dur = f.length ? fmtDur(parseFloat(f.length)) : '';
    const fmt = (f.format||'').toUpperCase().replace('VBR ','');
    const size = f.size ? Math.round(f.size/1048576)+'MB' : '';

    return `<div class="ia-file-row">
      <span class="ia-file-name" title="${escHtml(f.name)}">${safeName}</span>
      <span class="ia-file-dur">${dur}</span>
      <span style="font-size:6px;color:var(--text3);flex-shrink:0;">${fmt}</span>
      <button class="ia-file-btn play"
        onclick="iaPreviewFile('${safeUrl}','${safeName}',this)">▶</button>
      <button class="ia-file-btn"
        onclick="iaAddToPlaylist('${safeUrl}','${safeName}','${escHtml(identifier)}',${f.length||0})">＋</button>
    </div>`;
  }).join('');

  el.innerHTML = fileRows(show)
    + (rest.length
        ? `<button class="ia-expand-btn" onclick="iaShowMoreFiles('${identifier}','${containerId}')">
             ▸ Show ${rest.length} more tracks…
           </button>`
        : '');
}

function iaShowMoreFiles(identifier, containerId){
  const files = iaFilesCache[identifier];
  if(!files) return;
  iaRenderFiles(identifier, containerId, files); // re-render without limit
  // Override to show all
  const el = document.getElementById(containerId);
  if(!el) return;
  const allRows = files.map(f=>{
    const streamUrl = `https://archive.org/download/${identifier}/${encodeURIComponent(f.name)}`;
    const safeName  = escHtml(f.name.replace(/\.[^.]+$/, ''));
    const safeUrl   = escHtml(streamUrl);
    const dur = f.length ? fmtDur(parseFloat(f.length)) : '';
    const fmt = (f.format||'').toUpperCase().replace('VBR ','');
    return `<div class="ia-file-row">
      <span class="ia-file-name" title="${escHtml(f.name)}">${safeName}</span>
      <span class="ia-file-dur">${dur}</span>
      <span style="font-size:6px;color:var(--text3);flex-shrink:0;">${fmt}</span>
      <button class="ia-file-btn play"
        onclick="iaPreviewFile('${safeUrl}','${safeName}',this)">▶</button>
      <button class="ia-file-btn"
        onclick="iaAddToPlaylist('${safeUrl}','${safeName}','${escHtml(identifier)}',0)">＋</button>
    </div>`;
  }).join('');
  el.innerHTML = allRows;
}

// Preview: fetch as blob → create object URL → route through the FULL audio chain
async function iaPreviewFile(streamUrl, title, btnEl){
  if(btnEl){ btnEl.classList.add('loading'); btnEl.textContent='…'; }
  try{
    showToast('⏳ Fetching: '+title.substring(0,40));
    const resp = await fetch(streamUrl, { signal: AbortSignal.timeout(30000) });
    if(!resp.ok) throw new Error('HTTP '+resp.status);
    const blob = await resp.blob();
    const objUrl = URL.createObjectURL(blob);

    // Create a pseudo file object so loadTrackAndPlay can handle it
    const pseudoFile = new File([blob], title+'.mp3', { type: blob.type||'audio/mpeg' });
    const item = {
      id:        'ia_prev_'+Date.now(),
      artist:    'Internet Archive',
      title:     title,
      duration:  null,
      fileObj:   pseudoFile,
      type:      'ia',
      url:       streamUrl,
      bpm:       null, genre: '',
      introSec:  null, outroSec: null, schedTime: null
    };

    // Load into Deck A immediately and play
    if(masterAudio){ masterAudio.pause(); masterAudio.src=''; }
    initAudioCtx();
    if(masterSource){ try{masterSource.disconnect();}catch(e){} masterSource=null; }
    masterAudio = new Audio();
    masterAudio.crossOrigin = 'anonymous';
    masterAudio.src = objUrl;
    masterAudio.playbackRate = 1 + tempoState.A/100;
    masterAudio.addEventListener('timeupdate', onAudioTimeUpdate);
    masterAudio.addEventListener('ended',      onAudioEnded);
    masterAudio.addEventListener('loadedmetadata', onAudioMetadata);
    masterAudio.addEventListener('error', ()=>setPlayingUI(false));
    masterAudio._outroFired = false;

    // Don't add to playlist yet — just preview on Deck A
    // Push into a temp slot at nowPlayingIdx
    const tempIdx = STATE.nowPlayingIdx >= 0 ? STATE.nowPlayingIdx : 0;
    STATE.playlist.splice(tempIdx, 0, item);
    STATE.nowPlayingIdx = tempIdx;

    initAudioCtx();
    // setupEQ() will create mediaElementSource and wire EQ chain → masterGain
    masterAudio.crossOrigin = 'anonymous';
    if(item.introSec) masterAudio.currentTime = item.introSec;
    masterAudio.play().then(()=>{
      STATE.playing = true; STATE.paused = false;
      setPlayingUI(true);
      buildWaveformOverview(pseudoFile);
      drawWaveStrip('A', item);
      updateNowPlayingDisplay();
      renderPlaylist();
      addLog('song', title, '—');
      showToast('▶ Previewing: '+title.substring(0,40));
    }).catch(e=>{ setPlayingUI(false); showToast('⚠ Playback failed: '+e.message); });

  }catch(err){
    showToast('⚠ '+err.message.substring(0,60));
  }finally{
    if(btnEl){ btnEl.classList.remove('loading'); btnEl.textContent='▶'; }
  }
}

// Add to playlist: fetch as blob → store as File object → full mixer support
async function iaAddToPlaylist(streamUrl, title, identifier, durationSec){
  showToast('⏳ Fetching: '+title.substring(0,30)+'…');
  try{
    const resp = await fetch(streamUrl, { signal: AbortSignal.timeout(30000) });
    if(!resp.ok) throw new Error('HTTP '+resp.status);
    const blob = await resp.blob();
    const pseudoFile = new File([blob], title+'.mp3', { type: blob.type||'audio/mpeg' });

    // Extract duration from blob via AudioContext
    let dur = durationSec ? parseFloat(durationSec) : null;
    if(!dur){
      try{
        const arrBuf = await blob.arrayBuffer();
        const tmpCtx = new AudioContext();
        const decoded = await tmpCtx.decodeAudioData(arrBuf);
        dur = decoded.duration;
        tmpCtx.close();
      }catch(e){}
    }

    const item = {
      id:        'ia_'+Date.now(),
      artist:    identifier,
      title:     title,
      duration:  dur,
      fileObj:   pseudoFile,
      type:      'ia',
      url:       streamUrl,
      bpm:       null, genre: '',
      introSec:  null, outroSec: null, schedTime: null
    };

    addToPlaylist(item);
    showToast('＋ Added: '+title.substring(0,40));
    // Kick off waveform build in background
    buildWaveformOverview(pseudoFile);

  }catch(err){
    showToast('⚠ '+err.message.substring(0,60));
  }
}

// Kept for backward compat if anything still calls these
function renderYTResults(){}
function ytPlayResult(){}
function ytAddToPlaylist(){}

// ─── UPDATED brSwitchTab (adds ytsearch tab) ──────────
function brSwitchTab(tab){
  brCurrentTab=tab;
  // Update tab highlights — now 5 tabs
  const tabMap={dir:'brTabDir',ytsearch:'brTabYTsrch',yt:'brTabYT',url:'brTabUrl',lyrics:'brTabLyrics'};
  Object.entries(tabMap).forEach(([t,id])=>{
    document.getElementById(id)?.classList.toggle('on',t===tab);
  });
  const dirView=document.getElementById('brDirView');
  const ytSearchView=document.getElementById('brYTSearchView');
  const frameWrap=document.getElementById('ytFrameWrap');
  const urlBar=document.getElementById('brUrlBar');
  const addBtn=document.getElementById('brAddBtn');
  const notice=document.getElementById('brNotice');
  // Hide all panels
  [dirView,ytSearchView,frameWrap,urlBar].forEach(el=>{if(el)el.style.display='none';});
  if(addBtn) addBtn.style.display='none';
  if(tab==='dir'){
    if(dirView) dirView.style.display='flex';
    if(notice) notice.textContent='Click a station to open it in the frame';
  } else if(tab==='ytsearch'){
    if(ytSearchView) ytSearchView.style.display='flex';
    if(notice) notice.textContent='Internet Archive · free MP3s routed through your mixer';
    // Auto-focus search input
    setTimeout(()=>document.getElementById('ytSearchInput')?.focus(),100);
  } else if(tab==='yt'){
    if(urlBar) urlBar.style.display='flex';
    if(frameWrap) frameWrap.style.display='';
    if(addBtn) addBtn.style.display='';
    if(notice) notice.textContent='Paste a YouTube URL and press Go — or use the Search tab';
    const inp=document.getElementById('ytUrlInput');
    if(inp && !inp.value) inp.placeholder='https://www.youtube.com/watch?v=...';
  } else if(tab==='url'){
    if(urlBar) urlBar.style.display='flex';
    if(frameWrap) frameWrap.style.display='';
    if(notice) notice.textContent='Type any URL — some sites block iframe embedding';
    const inp=document.getElementById('ytUrlInput');
    if(inp) inp.placeholder='https://...';
  } else if(tab==='lyrics'){
    if(frameWrap) frameWrap.style.display='';
    const item=STATE.playlist[STATE.nowPlayingIdx];
    const artist=item?.artist||'';
    const title=item?.title||'';
    if(artist||title){
      const q=encodeURIComponent(artist+' '+title+' lyrics');
      brLoadFrame('https://duckduckgo.com/?q='+q+'&ia=web','Lyrics: '+artist+' – '+title);
      if(notice) notice.textContent='Lyrics search: '+artist+' – '+title;
    } else {
      brLoadFrame('https://duckduckgo.com/?q=song+lyrics&ia=web','Search for lyrics');
      if(notice) notice.textContent='No track playing — showing general lyrics search';
    }
  }
}

// ─── PLAYLIST DRAG-REORDER ────────────────────────────
let plDragSrcIdx=-1;

function onPlDragStart(e,idx){
  plDragSrcIdx=idx;
  e.dataTransfer.effectAllowed='move';
  e.dataTransfer.setData('text/plain',String(idx));
  // Add dragging style after a tick
  setTimeout(()=>{
    const el=document.querySelector(`.pl-item[data-idx="${idx}"]`);
    if(el) el.classList.add('drag-reorder-dragging');
  },0);
}

function onPlDragOverItem(e,idx){
  e.preventDefault();
  e.dataTransfer.dropEffect='move';
  // Clear all over-styles then set on this one
  document.querySelectorAll('.pl-item').forEach(el=>el.classList.remove('drag-reorder-over'));
  if(idx!==plDragSrcIdx){
    const el=document.querySelector(`.pl-item[data-idx="${idx}"]`);
    if(el) el.classList.add('drag-reorder-over');
  }
}

function onPlDropItem(e,toIdx){
  e.preventDefault();
  e.stopPropagation();
  document.querySelectorAll('.pl-item').forEach(el=>{
    el.classList.remove('drag-reorder-over');
    el.classList.remove('drag-reorder-dragging');
  });
  const fromIdx=plDragSrcIdx;
  plDragSrcIdx=-1;
  if(fromIdx<0||fromIdx===toIdx) return;
  // Reorder
  const item=STATE.playlist.splice(fromIdx,1)[0];
  const insertAt=toIdx>fromIdx?toIdx-1:toIdx;
  STATE.playlist.splice(insertAt,0,item);
  // Fix now-playing index
  if(STATE.nowPlayingIdx===fromIdx) STATE.nowPlayingIdx=insertAt;
  else if(fromIdx<STATE.nowPlayingIdx && insertAt>=STATE.nowPlayingIdx) STATE.nowPlayingIdx--;
  else if(fromIdx>STATE.nowPlayingIdx && insertAt<=STATE.nowPlayingIdx) STATE.nowPlayingIdx++;
  STATE.selectedPlIdx=insertAt;
  recalcPlaylistTimes(); renderPlaylist();
}

// ─── AUTO LYRICS FETCH (Claude API) ───────────────────
const lyrAICache={};

// ── Lyrics fetch using lrclib.net — free, open, CORS-enabled, works on GitHub Pages ──
async function autoFetchLyrics(forceRegen){
  const item=STATE.playlist[STATE.nowPlayingIdx];
  if(!item){showToast('No track playing');return;}
  const artist=(item.artist||'').trim();
  const title=(item.title||'').trim();
  if(!artist&&!title){showToast('Track has no artist/title info');return;}
  const key=lyricsKey(item);
  if(!forceRegen && key && lyricsStore[key]?.lines?.length){
    showToast('Lyrics already loaded — use ✕ Clear then ✨ to reload');
    return;
  }
  const btn=document.getElementById('lyrAiBtn');
  const lbl=document.getElementById('lyrSourceLbl');
  const sc=document.getElementById('lyricsScroll');
  if(btn){btn.textContent='⏳ Searching…';btn.classList.add('ai-loading');btn.disabled=true;}
  if(lbl){lbl.textContent='🔍 Fetching…';lbl.className='lyr-source-lbl';}

  try{
    // ── Step 1: Search lrclib for the track ──
    // lrclib.net is a free public lyrics DB with CORS headers — works from any browser
    const searchUrl='https://lrclib.net/api/search?'
      +new URLSearchParams({
        track_name: title,
        artist_name: artist
      });

    const searchResp=await fetch(searchUrl,{
      headers:{'Lrclib-Client':'BroadcastPro FM (github.com)'},
      signal:AbortSignal.timeout(8000)
    });

    if(!searchResp.ok) throw new Error('lrclib search failed: '+searchResp.status);
    const results=await searchResp.json();

    // ── Step 2: Pick best match (prefer synced lyrics) ──
    const withSynced=results.filter(r=>r.syncedLyrics);
    const withPlain =results.filter(r=>r.plainLyrics);
    const best=withSynced[0]||withPlain[0]||results[0];

    if(!best){
      // No results — show helpful message instead of error
      if(lbl){lbl.textContent='not found';lbl.className='lyr-source-lbl';}
      if(sc) sc.innerHTML=`<div class="lyrics-no-data">
        <span style="font-size:18px;">🎵</span><br><br>
        No lyrics found for<br>
        <strong style="color:var(--text);">${escHtml(title)}</strong>
        ${artist?`<br><span style="color:var(--text2);">by ${escHtml(artist)}</span>`:''}
        <br><br>
        <span style="font-size:9px;color:var(--text3);">
          Try loading a <strong>.lrc file</strong> manually,<br>
          or search online below.
        </span><br><br>
        <a onclick="lyricsSearchWeb()" style="color:var(--blue);cursor:pointer;">🔍 Search Lyrics Online ↗</a>
      </div>`;
      showToast('No lyrics found for: '+title);
      return;
    }

    // ── Step 3: Parse and store ──
    let lines=[];
    let source='plain';
    if(best.syncedLyrics){
      lines=parseLRC(best.syncedLyrics);
      source='synced';
    }
    if(!lines.length && best.plainLyrics){
      // Convert plain lyrics to timed lines (4s per line starting at 8s)
      const textLines=best.plainLyrics.split('\n').map(l=>l.trim()).filter(l=>l);
      lines=textLines.map((text,i)=>({t:8+i*4,text}));
      source='plain';
    }
    if(!lines.length) throw new Error('Could not parse lyrics data');

    lyricsStore[key]={lines,source,file:'lrclib.net'};
    renderLyrics(title,artist);
    if(lbl){
      lbl.textContent=source==='synced'?'● LRC synced':'● plain text';
      lbl.className='lyr-source-lbl lrc';
    }
    const srcNote=source==='synced'?'synced lyrics':'plain lyrics';
    showToast('✓ Lyrics loaded ('+srcNote+'): '+lines.length+' lines');
    addLog('system','Lyrics fetched: '+artist+' – '+title,' lrclib');

  }catch(err){
    if(lbl){lbl.textContent='⚠ not found';lbl.className='lyr-source-lbl';}
    if(sc) sc.innerHTML=`<div class="lyrics-no-data">
      <span style="font-size:16px;">⚠️</span><br><br>
      Could not load lyrics<br>
      <span style="font-size:9px;color:var(--text3);">${escHtml(err.message)}</span>
      <br><br>
      <a onclick="autoFetchLyrics(true)" style="color:var(--blue);cursor:pointer;margin-right:12px;">↺ Retry</a>
      <a onclick="lyricsSearchWeb()" style="color:var(--blue);cursor:pointer;">🔍 Search Web</a>
      <br><br>
      <span style="font-size:8px;color:var(--text3);">
        Or drop a <strong>.lrc file</strong> on the drop zone above
      </span>
    </div>`;
    showToast('Lyrics: '+err.message.substring(0,60));
  }finally{
    if(btn){btn.textContent='✨ Lyrics';btn.classList.remove('ai-loading');btn.disabled=false;}
  }
}

// ─── AUTOBPM + AUTOSYNC (YouDJ-style) ──────────────────────
let autoBpmEnabled  = false;
let autoSyncEnabled = false;
let autoSyncInterval = null;
let bpmFactor = 0; // percent shift applied to deck B to match deck A

function toggleAutoBpm(){
  autoBpmEnabled = !autoBpmEnabled;
  const btn = document.getElementById('autoBpmToggle');
  const st  = document.getElementById('autoBpmState');
  if(btn) btn.classList.toggle('active', autoBpmEnabled);
  if(st)  st.textContent = autoBpmEnabled ? 'ON' : 'OFF';
  if(autoBpmEnabled){
    // Auto-detect on both decks if no BPM yet
    const itemA = STATE.playlist[STATE.nowPlayingIdx];
    const itemB = STATE.playlist[deckBTrackIdx >= 0 ? deckBTrackIdx : STATE.nowPlayingIdx+1];
    if(itemA?.fileObj && !liveBpm.A) autoDetectBpm('A');
    if(itemB?.fileObj && !liveBpm.B) autoDetectBpm('B');
    showToast('AutoBPM ON — detecting BPM automatically');
  } else {
    showToast('AutoBPM OFF');
  }
  updateYdjBpmFactor();
}

function toggleAutoSync(){
  autoSyncEnabled = !autoSyncEnabled;
  const btn = document.getElementById('autoSyncToggle');
  const st  = document.getElementById('autoSyncState');
  if(btn) btn.classList.toggle('active', autoSyncEnabled);
  if(st)  st.textContent = autoSyncEnabled ? 'ON' : 'OFF';
  const dot = document.getElementById('ydj-sync-dot');
  if(dot) dot.classList.toggle('synced', autoSyncEnabled);

  if(autoSyncEnabled){
    // Immediately sync B → A
    applyAutoSync();
    // Keep syncing every 4s to drift-correct
    autoSyncInterval = setInterval(applyAutoSync, 4000);
    showToast('AutoSYNC ON — Deck B will follow Deck A BPM');
  } else {
    clearInterval(autoSyncInterval);
    autoSyncInterval = null;
    showToast('AutoSYNC OFF');
  }
}

function applyAutoSync(){
  if(!autoSyncEnabled) return;
  const a = liveBpm.A, b = liveBpm.B;
  if(!a || !b) return;
  const ratio  = a / b;
  const factorPct = (ratio - 1) * 100;
  bpmFactor = factorPct;
  if(deckBAudio){
    deckBAudio.playbackRate = ratio * (1 + tempoState.B / 100);
  }
  // Update BPM factor display
  updateYdjBpmFactor();
  addLog('system', `AutoSYNC: B adjusted ${factorPct >= 0 ? '+' : ''}${factorPct.toFixed(1)}%`, '—');
}

function nudgeBpmFactor(delta){
  bpmFactor += delta;
  bpmFactor = Math.max(-10, Math.min(10, bpmFactor));
  if(deckBAudio){
    const ratio = 1 + bpmFactor / 100;
    deckBAudio.playbackRate = ratio * (1 + tempoState.B / 100);
    if(liveBpm.B) liveBpm.B = Math.round((liveBpm.B || 120) * ratio);
  }
  updateYdjBpmFactor();
}

function nudgeBpm(delta){
  // Nudge the global BPM display (Deck A reference)
  if(masterAudio){
    const curRate = masterAudio.playbackRate;
    masterAudio.playbackRate = Math.max(0.5, Math.min(2.0, curRate + delta * 0.01));
    const newBpm = Math.round((liveBpm.A || 120) * masterAudio.playbackRate);
    liveBpm.A = newBpm;
    updateBpmDisplay('A', newBpm, 'NUDGE');
    updateYdjBpmFactor();
  }
}

function updateYdjBpmFactor(){
  const fv = document.getElementById('ydj-bpm-factor');
  const ff = document.getElementById('ydj-bpmf-fill');
  if(fv) fv.textContent = (bpmFactor >= 0 ? '+' : '') + bpmFactor.toFixed(1) + '%';
  // Map -10..+10 to 0..100% bar fill, center = 50%
  const pct = 50 + (bpmFactor / 10) * 50;
  if(ff) ff.style.width = Math.max(2, Math.min(98, pct)) + '%';
  // Update banner BPM display
  const mainBpm = document.getElementById('ydj-bpm-main');
  if(mainBpm){
    const bpm = liveBpm.A || liveBpm.B;
    mainBpm.textContent = bpm ? Math.round(bpm) : '—';
  }
}

// ── Keep ydj header track info updated ──────────────────
function updateYdjHeaders(){
  // When activeDeck='A': A is playing nowPlayingIdx, B has nowPlayingIdx+1 pre-loaded
  // When activeDeck='B': B is playing nowPlayingIdx, A has nowPlayingIdx+1 pre-buffered
  const playingIdx = STATE.nowPlayingIdx;
  const nextIdx    = playingIdx + 1;

  const itemActive = STATE.playlist[playingIdx];
  const itemNext   = STATE.playlist[nextIdx];

  const itemA = activeDeck === 'A' ? itemActive : itemNext;
  const itemB = activeDeck === 'B' ? itemActive : itemNext;

  const ta = document.getElementById('ydj-title-a');
  const tb = document.getElementById('ydj-title-b');
  const mkTitle = item => item ? (item.artist ? item.artist + ' – ' + item.title : item.title) : 'No track loaded';
  if(ta) ta.textContent = mkTitle(itemA);
  if(tb) tb.textContent = mkTitle(itemB);

  // Time displays — read from actual audio elements
  const posA = masterAudio?.currentTime || 0;
  const durA = masterAudio?.duration    || itemA?.duration || 0;
  const posB = deckBAudio?.currentTime  || 0;
  const durB = deckBAudio?.duration     || itemB?.duration || 0;

  const colorFn = (remaining, dur) => {
    if(!dur) return '#ff8844';
    const pct = remaining / dur;
    return pct < 0.15 ? '#ff3333' : pct < 0.3 ? '#ffaa00' : '#ff8844';
  };

  const tma = document.getElementById('ydj-time-a');
  const tmb = document.getElementById('ydj-time-b');
  if(tma){
    // Deck A time: if activeDeck='B', masterAudio is pre-buffered (show 0:00 / duration)
    const showPos = activeDeck === 'A' ? posA : 0;
    const showDur = activeDeck === 'A' ? durA : (itemA?.duration || durA);
    tma.textContent = fmtDur(showPos) + ' / ' + fmtDur(showDur);
    tma.style.color = colorFn(showDur - showPos, showDur);
  }
  if(tmb){
    const showPos = activeDeck === 'B' ? posB : (deckBAudio?.currentTime || 0);
    const showDur = activeDeck === 'B' ? durB : (itemB?.duration || durB);
    tmb.textContent = fmtDur(showPos) + ' / ' + fmtDur(showDur);
    tmb.style.color = colorFn(showDur - showPos, showDur);
  }

  // Update banner BPM
  updateYdjBpmFactor();
}

// Patch onAudioTimeUpdate to also call updateYdjHeaders
const _origOnAudioTimeUpdate = onAudioTimeUpdate;

// ═══════════════════════════════════════════════════════
// FX PAD — YouDJ-style: HOLD = FX ON at full wet, RELEASE = FX OFF
// No XY dragging. Press and hold the pad to hear the effect.
// The pad glows and pulses while held.
// ═══════════════════════════════════════════════════════
const fxPadState = { A: { held: false }, B: { held: false } };

function fxPadStart(deck, e) {
  e.preventDefault();
  if (fxPadState[deck].held) return;
  fxPadState[deck].held = true;

  const type = fxState[deck].type;
  if (!type || type === 'none') {
    showToast('Select an FX first from the dropdown');
    fxPadState[deck].held = false;
    return;
  }

  const pad = document.getElementById('fxPad' + deck);
  if (pad) { pad.classList.add('active', 'touching'); }

  // Set full wet for the hold
  fxState[deck].wet = 100;
  fxState[deck].p1  = 80;
  fxState[deck].p2  = 60;

  // Turn on and activate
  fxState[deck].on = true;
  const onBtn = document.getElementById('fxPadOn' + deck);
  if (onBtn) { onBtn.textContent = 'ON'; onBtn.classList.add('on'); }
  activateFX(deck);

  // Pulse animation
  _fxPadPulse(deck, true);
}

function fxPadEnd(deck) {
  if (!fxPadState[deck].held) return;
  fxPadState[deck].held = false;

  const pad = document.getElementById('fxPad' + deck);
  if (pad) { pad.classList.remove('active', 'touching'); }

  // Turn off FX on release
  fxState[deck].on = false;
  deactivateFX(deck);
  const onBtn = document.getElementById('fxPadOn' + deck);
  if (onBtn) { onBtn.textContent = 'OFF'; onBtn.classList.remove('on'); }

  _fxPadPulse(deck, false);
}

// Move is a no-op (no XY — just hold)
function fxPadMove(deck, e) { e.preventDefault(); }

// Pulse the dot while held
function _fxPadPulse(deck, on) {
  const dot = document.getElementById('fxPadDot' + deck);
  if (!dot) return;
  if (on) {
    dot.style.animation = 'fxPadPulse 0.4s ease-in-out infinite alternate';
  } else {
    dot.style.animation = '';
    // Reset dot to center
    dot.style.left = '50%';
    dot.style.top  = '50%';
  }
}

function updateFxPadLabel(deck) {
  const sel = document.getElementById('fxSelect' + deck);
  const val = sel ? sel.value : 'none';
  fxState[deck].type = val;
  const nameEl = document.getElementById('fxPadName' + deck);
  const padSel  = document.getElementById('fxPadSel'  + deck);
  const names = { none:'— FX —', echo:'Echo', reverb:'Reverb', flanger:'Flanger', filter:'Filter Sweep', bitcrush:'Bitcrush', stutter:'Stutter', slicer:'Slicer', phaser:'Phaser', brake:'Brake', tapestop:'Tape Stop' };
  if (nameEl) nameEl.textContent = names[val] || val;
  if (padSel) padSel.value = val;
  // Update pad center label
  const ctrLbl = document.getElementById('fxPadCtr' + deck);
  if (ctrLbl) ctrLbl.textContent = val !== 'none' ? (names[val]||val).toUpperCase() : 'HOLD';
}

// Helper to visually update a rknob after programmatic value change
function updateKnobVisual(knob) {
  if (!knob) return;
  const val = parseFloat(knob.dataset.val);
  const min = parseFloat(knob.dataset.min || 0);
  const max = parseFloat(knob.dataset.max || 100);
  const pct = (val - min) / (max - min);
  const deg = -135 + pct * 270;
  const ind = knob.querySelector('.rknob-indicator');
  if (ind) {
    ind.style.transform = `translateX(-50%) rotate(${deg}deg)`;
    ind.style.transformOrigin = 'bottom center';
  }
}

// ─── INIT ─────────────────────────────────────────────
function init(){
  loadSwBanks();
  renderBankTabs(); renderSwGrid(); renderPlaylist();
  updateNowPlayingDisplay(); updateTimingDisplay();
  initPlatters(); initDeckFaders(); initKnobs(); initKnobVisuals();
  renderPerfPads('A'); renderPerfPads('B');
  initMic();
  brRenderStations();
  applyTheme();
  // Turn autoplay ON by default
  STATE.autoplay=true;
  const apb=document.getElementById('bbAutoplay');
  if(apb){apb.classList.add('on');apb.textContent='▶ Autoplay ON';}
  addLog('system','BroadcastPro FM ready — Autoplay ON','—');
  ['insertPosFile','insertPosInput'].forEach(id=>{document.getElementById(id)?.addEventListener('input',function(){syncInsertPos(this.value);});});
  setInterval(()=>{if(STATE.playing){recalcPlaylistTimes();}else{updateNextEmptySlot();updateTimingDisplay();}},4000);
  console.log('BroadcastPro FM v10 initialized');
}
window.addEventListener('load',init);



// ─── ZOOM CONTROLS ─────────────────────────────────
(function(){
  let z = 1;
  try{ z = parseFloat(localStorage.getItem('bpfm_zoom'))||1; }catch(e){}
  z = Math.max(0.6, Math.min(1.5, z));

  function apply(zoom){
    z = Math.max(0.6, Math.min(1.5, zoom));
    document.documentElement.style.zoom = z;
    const lbl = document.getElementById('zoomHudLbl');
    if(lbl) lbl.textContent = Math.round(z*100)+'%';
    try{ localStorage.setItem('bpfm_zoom', z); }catch(e){}
  }
  window.bpZoom      = d => apply(z + d);
  window.bpZoomReset = () => apply(1);

  // Ctrl/Cmd +/- keyboard shortcut
  document.addEventListener('keydown', e => {
    if(!(e.ctrlKey || e.metaKey)) return;
    if(e.key === '=' || e.key === '+'){e.preventDefault(); bpZoom(+0.05);}
    else if(e.key === '-'){e.preventDefault(); bpZoom(-0.05);}
    else if(e.key === '0'){e.preventDefault(); bpZoomReset();}
  });

  apply(z); // restore saved zoom on load
})();
