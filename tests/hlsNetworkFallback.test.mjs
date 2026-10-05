import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { ErrorDetails, ErrorTypes } from 'hls.js';
import { sourceEffect, sourceFunction } from './helpers/sourceFunction.mjs';
import { getLocalPlaybackInitPolicy } from '../src/utils/castLocalPlaybackRecovery.ts';
import { createHlsAutoFallbackGuard } from '../src/utils/hlsAutoFallbackGuard.ts';
import { isVideoLevelFailure } from '../src/utils/hlsQuality.ts';
import { isDnsLikeError } from '../src/utils/dnsErrorDetection.ts';

const noop = () => {};
const silentConsole = { log: noop, warn: noop, error: noop };
const src = 'https://media.test/master.m3u8';
const nextSrc = 'https://alternative.test/master.m3u8';
// Même forme que le segment signalé, sans recopier son URL signée.
const initUrl = 'https://cdn.test/v4/video/init-f1-v1-a1.woff';

function networkFailure(overrides = {}) {
  return {
    type: ErrorTypes.NETWORK_ERROR, details: ErrorDetails.FRAG_LOAD_ERROR,
    fatal: false, response: { code: 0 }, networkDetails: { status: 0 },
    error: new Error('HTTP Error 0'),
    frag: { type: 'main', sn: 'initSegment', level: 0, url: initUrl },
    ...overrides,
  };
}

function playerFixture() {
  const video = Object.assign(new EventTarget(), {
    currentTime: 120, textTracks: [], paused: true, setAttribute: noop,
  });
  const hlsRef = { current: null };
  const changes = [];
  const owner = {};
  const guard = createHlsAutoFallbackGuard(2);
  guard.syncActiveSource(src, owner);
  const window = { dispatchEvent: event => changes.push(event.detail) };
  const nexusHlsSources = [{ url: src }, { url: nextSrc }];
  const tryNextNexusHlsSource = sourceFunction('src/components/HLSPlayer.tsx', 'tryNextNexusHlsSource', {
    useCallback: callback => callback, src, nexusHlsSources, currentNexusHlsIndex: 0,
    setCurrentNexusHlsIndex: noop, showOsd: noop, t: key => key,
    window, console: silentConsole,
  });
  const handleHlsError = sourceFunction('src/components/HLSPlayer.tsx', 'handleHlsError', {
    src, videoRef: { current: video }, setCurrentTime: noop,
    darkinoSources: [], currentDarkiIndex: 0, nexusHlsSources, currentNexusHlsIndex: 0,
    nexusFileSources: [], purstreamSources: [], omegaSources: [], coflixSources: [],
    tryNextNexusHlsSource, setTimeout: noop, console: silentConsole,
  });
  const requestHlsFallback = sourceFunction('src/components/HLSPlayer.tsx', 'requestHlsFallback', {
    useCallback: callback => callback, src, resolvedAutoFallbackGuard: guard,
    playerAutoFallbackOwnerRef: { current: owner }, handleHlsErrorRef: { current: handleHlsError },
    setIsLoading: noop, setIsBuffering: noop, setHasFatalPlaybackError: noop,
    onShowSourcesRef: { current: noop },
  });
  class Hls extends EventEmitter {
    static Events = new Proxy({}, { get: (_, name) => name });
    static ErrorTypes = ErrorTypes;
    static ErrorDetails = ErrorDetails;
    static isSupported = () => true;
    levels = [{ height: 720 }];
    currentLevel = 0;
    starts = 0;
    stops = 0;
    subtitleTrack = 0;
    loadSource() {}
    attachMedia() {}
    startLoad() { this.starts++; }
    stopLoad() { this.stops++; }
    destroy() { this.removeAllListeners(); }
  }
  const cleanup = sourceEffect('src/components/HLSPlayer.tsx', 'const clearSourceTimeout', {
    isCasting: false, Hls, hlsRef, videoRef: { current: video },
    nativeAirPlay: false, playbackRestoreRef: { current: null }, autoPlay: false,
    postCastPlaybackSuppressedRef: { current: false }, getLocalPlaybackInitPolicy,
    bufferingTimeoutRef: { current: null }, sourceTimeoutRef: { current: null },
    setTimeout: noop, clearTimeout: noop, setIsLoading: noop, setIsBuffering: noop,
    requestHlsFallback, src, normalizeUqloadEmbedUrl: url => url,
    kisskhSources: [], isMP4Source: () => false, contentTypeMp4Urls: new Set(),
    createHlsConfig: () => ({}), purstreamSources: [], console: silentConsole, window,
    failed429Segments: new Set(), isVideoLevelFailure, isDnsLikeError,
    decideHlsAudioFailure: fatal => fatal ? 'switch-source' : 'keep-source',
    isSubtitleLoadError: sourceFunction('src/components/HLSPlayer.tsx', 'isSubtitleLoadError'),
  })();
  const hls = hlsRef.current;
  return {
    hls, cleanup, changes, guard,
    fail: data => hls.emit(Hls.Events.ERROR, null, data),
    loaded: type => hls.emit(Hls.Events.FRAG_LOADED, null, { frag: { type, sn: 'initSegment' } }),
  };
}

test('un init .woff sans réponse change de serveur après trois erreurs non fatales', () => {
  const fixture = playerFixture();
  try {
    fixture.fail(networkFailure());
    fixture.fail(networkFailure());
    assert.equal(fixture.changes.length, 0, 'deux tentatives restent disponibles');
    fixture.fail(networkFailure());
    assert.deepEqual(fixture.changes, [{
      type: 'nexus_hls', id: 'nexus_hls_1', url: nextSrc,
      origin: 'auto-fallback', fromSrc: src,
    }]);
    assert.equal(fixture.hls.starts, 0, 'le lecteur laisse HLS gérer les retries');
    assert.equal(fixture.hls.stops, 1, 'le chargement défaillant est arrêté');
    fixture.fail(networkFailure());
    assert.equal(fixture.changes.length, 1, 'un seul changement est accepté par source');
  } finally { fixture.cleanup(); }
});

test('un incident isolé laisse HLS réessayer sans relancer tout le chargement', () => {
  const fixture = playerFixture();
  try {
    fixture.fail(networkFailure());
    assert.equal(fixture.hls.starts, 0);
    fixture.loaded('main');
    fixture.fail(networkFailure());
    fixture.fail(networkFailure());
    assert.equal(fixture.changes.length, 0);
  } finally { fixture.cleanup(); }
});

test('des fragments audio reçus ne masquent pas une panne des segments vidéo', () => {
  const fixture = playerFixture();
  try {
    for (let i = 0; i < 3; i++) {
      fixture.fail(networkFailure());
      fixture.loaded('audio');
    }
    assert.equal(fixture.changes.length, 1);
  } finally { fixture.cleanup(); }
});

test('un init audio sans réponse déclenche aussi le repli sans attendre fatal', () => {
  const fixture = playerFixture();
  try {
    for (let i = 0; i < 3; i++) {
      fixture.fail(networkFailure({ frag: { type: 'audio', sn: 'initSegment', url: initUrl } }));
      fixture.loaded('main');
    }
    assert.equal(fixture.changes.length, 1);
  } finally { fixture.cleanup(); }
});

test('un sous-titre inaccessible ne change jamais de serveur', () => {
  const fixture = playerFixture();
  try {
    for (let i = 0; i < 4; i++) {
      fixture.fail(networkFailure({ frag: { type: 'subtitle', url: 'https://cdn.test/track.ts' } }));
    }
    assert.equal(fixture.changes.length, 0);
    assert.equal(fixture.hls.subtitleTrack, -1);
  } finally { fixture.cleanup(); }
});

test('une réponse HTTP reste traitée par la politique HTTP existante', () => {
  const fixture = playerFixture();
  try {
    for (let i = 0; i < 4; i++) {
      fixture.fail(networkFailure({ response: { code: 503 } }));
    }
    assert.equal(fixture.changes.length, 0);
  } finally { fixture.cleanup(); }
});

test('une ancienne source ne consomme pas le budget de repli de la nouvelle', () => {
  const fixture = playerFixture();
  try {
    fixture.guard.syncActiveSource(nextSrc, {});
    for (let i = 0; i < 3; i++) fixture.fail(networkFailure());
    assert.equal(fixture.changes.length, 0);
    assert.equal(fixture.guard.getAutomaticSwitchCount(), 0);
  } finally { fixture.cleanup(); }
});

test('une erreur réseau déjà fatale demande immédiatement le serveur suivant', () => {
  const fixture = playerFixture();
  try {
    fixture.fail(networkFailure({ fatal: true }));
    assert.equal(fixture.changes.length, 1);
    assert.equal(fixture.hls.starts, 0);
  } finally { fixture.cleanup(); }
});

test('les timeouts sans objet response restent bornés', () => {
  const fixture = playerFixture();
  try {
    for (let i = 0; i < 3; i++) {
      fixture.fail(networkFailure({ details: ErrorDetails.FRAG_LOAD_TIMEOUT, response: undefined, networkDetails: undefined }));
    }
    assert.equal(fixture.changes.length, 1);
  } finally { fixture.cleanup(); }
});

test('une réponse HTTP interrompt une série d’erreurs sans réponse', () => {
  const fixture = playerFixture();
  try {
    fixture.fail(networkFailure());
    fixture.fail(networkFailure());
    fixture.fail(networkFailure({ response: { code: 503 } }));
    fixture.fail(networkFailure());
    assert.equal(fixture.changes.length, 0);
  } finally { fixture.cleanup(); }
});

test('changer de source repart avec un compteur réseau neuf', () => {
  const previous = playerFixture();
  previous.fail(networkFailure());
  previous.fail(networkFailure());
  previous.cleanup();
  const next = playerFixture();
  try {
    next.fail(networkFailure());
    assert.equal(next.changes.length, 0);
  } finally { next.cleanup(); }
});
