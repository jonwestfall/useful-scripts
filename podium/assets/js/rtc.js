// WebRTC camera feed: point your phone at a book, a worksheet, or the room, and
// it lands on the projector. Signalling rides the same encrypted bus.
//
// STUN only, no TURN. On a normal campus network the two devices reach each
// other directly; on a guest network with client isolation this is the one
// piece that can fail, and the UI says so rather than hanging.

const ICE = { iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }] };

// Display side.
export function createCameraReceiver({ bus, onStream, onState }) {
  let pc = null;
  let peerId = null;

  const teardown = () => {
    if (pc) { try { pc.close(); } catch { /* noop */ } }
    pc = null;
    peerId = null;
    onStream(null);
    onState('idle');
  };

  async function handle(msg) {
    if (msg.t !== 'rtc') return;

    if (msg.kind === 'offer') {
      teardown();
      peerId = msg.from;
      pc = new RTCPeerConnection(ICE);
      pc.ontrack = (ev) => { onStream(ev.streams[0]); onState('live'); };
      pc.onicecandidate = (ev) => {
        if (ev.candidate) bus.send({ t: 'rtc', kind: 'ice', to: peerId, candidate: ev.candidate.toJSON() });
      };
      pc.onconnectionstatechange = () => {
        if (!pc) return;
        if (pc.connectionState === 'connected') onState('live');
        if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) teardown();
      };
      onState('connecting');
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

    if (msg.kind === 'stop' && msg.from === peerId) teardown();
  }

  return { handle, stop: teardown };
}

// Controller side.
export function createCameraSender({ bus, onState, onLocalStream }) {
  let pc = null;
  let stream = null;
  let displayId = null;

  async function start({ facingMode = 'environment' } = {}) {
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
      if (pc.connectionState === 'connected') onState('live');
      if (pc.connectionState === 'failed') onState('failed');
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    bus.send({ t: 'rtc', kind: 'offer', sdp: { type: offer.type, sdp: offer.sdp } });
    onState('connecting');
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
