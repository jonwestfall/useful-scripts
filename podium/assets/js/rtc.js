// WebRTC camera feed: point your phone at a book, a worksheet, or the room, and
// it lands on the projector. Signalling rides the same encrypted bus.
//
// STUN only, no TURN. On a normal campus network the two devices reach each
// other directly; on a guest network with client isolation this is the one
// piece that can fail, and the UI says so rather than hanging.

const ICE = { iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }] };

// With no TURN server, a connection that has not reached "connected" by now is
// not going to: on a network that blocks direct peer traffic, some browsers
// simply stay in "connecting" indefinitely rather than ever announcing
// "failed". Without this, the display would say "Connecting…" forever.
const CONNECT_TIMEOUT_MS = 15000;

// Display side.
export function createCameraReceiver({ bus, onStream, onState }) {
  let pc = null;
  let peerId = null;
  let timeout = null;

  const teardown = (status = 'idle') => {
    clearTimeout(timeout);
    if (pc) { try { pc.close(); } catch { /* noop */ } }
    pc = null;
    peerId = null;
    onStream(null);
    onState(status);
  };

  async function handle(msg) {
    if (msg.t !== 'rtc') return;

    if (msg.kind === 'offer') {
      teardown();
      peerId = msg.from;
      pc = new RTCPeerConnection(ICE);
      pc.ontrack = (ev) => { clearTimeout(timeout); onStream(ev.streams[0]); onState('live'); };
      pc.onicecandidate = (ev) => {
        if (ev.candidate) bus.send({ t: 'rtc', kind: 'ice', to: peerId, candidate: ev.candidate.toJSON() });
      };
      pc.onconnectionstatechange = () => {
        if (!pc) return;
        if (pc.connectionState === 'connected') { clearTimeout(timeout); onState('live'); }
        if (pc.connectionState === 'failed') { teardown('failed'); return; }
        if (['closed', 'disconnected'].includes(pc.connectionState)) teardown('idle');
      };
      onState('connecting');
      timeout = setTimeout(() => { if (pc && pc.connectionState !== 'connected') teardown('failed'); }, CONNECT_TIMEOUT_MS);
      await pc.setRemoteDescription(msg.sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      bus.send({ t: 'rtc', kind: 'answer', to: peerId, sdp: { type: answer.type, sdp: answer.sdp } });
      return;
    }

    if (msg.kind === 'ice' && pc && msg.from === peerId) {
      try { await pc.addIceCandidate(msg.candidate); } catch { /* candidate arrived too early or too late */ }
      return;
    }

    if (msg.kind === 'stop' && msg.from === peerId) teardown('idle');
  }

  return { handle, stop: () => teardown('idle') };
}

// Controller side.
export function createCameraSender({ bus, onState, onLocalStream }) {
  let pc = null;
  let stream = null;
  let displayId = null;
  let timeout = null;

  async function start({ facingMode = 'environment' } = {}) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(location.protocol === 'https:' || location.hostname === 'localhost'
        ? 'This browser has no camera access.'
        : 'The camera needs a secure (https://) connection - it will not work over plain http.');
    }
    await stop();
    onState('requesting');
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
    onLocalStream(stream);

    pc = new RTCPeerConnection(ICE);
    stream.getTracks().forEach((track) => pc.addTrack(track, stream));
    pc.onicecandidate = (ev) => {
      if (ev.candidate) bus.send({ t: 'rtc', kind: 'ice', to: displayId || undefined, candidate: ev.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      if (!pc) return;
      if (pc.connectionState === 'connected') { clearTimeout(timeout); onState('live'); }
      if (pc.connectionState === 'failed') onState('failed');
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    bus.send({ t: 'rtc', kind: 'offer', sdp: { type: offer.type, sdp: offer.sdp } });
    onState('connecting');
    clearTimeout(timeout);
    // See the matching comment in createCameraReceiver: without a TURN
    // server, "still connecting" after this long means it never will.
    timeout = setTimeout(() => { if (pc && pc.connectionState !== 'connected') onState('failed'); }, CONNECT_TIMEOUT_MS);
  }

  async function handle(msg) {
    if (msg.t !== 'rtc' || !pc) return;
    if (msg.kind === 'answer') {
      displayId = msg.from;
      try { await pc.setRemoteDescription(msg.sdp); } catch { onState('failed'); }
      return;
    }
    if (msg.kind === 'ice') {
      try { await pc.addIceCandidate(msg.candidate); } catch { /* ignore */ }
    }
  }

  async function stop() {
    clearTimeout(timeout);
    if (pc) { bus.send({ t: 'rtc', kind: 'stop' }); try { pc.close(); } catch { /* noop */ } }
    pc = null;
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    displayId = null;
    onLocalStream(null);
    onState('idle');
  }

  return { start, stop, handle, get active() { return !!pc; } };
}
