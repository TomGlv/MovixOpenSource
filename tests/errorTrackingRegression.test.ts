import assert from 'node:assert/strict';
import test from 'node:test';
import { sourceFunction } from './helpers/sourceFunction.mjs';

test('la disparition du document déclenche la récupération au lieu de cascades de crashs DOM', () => {
  const isRecoverable = sourceFunction('src/utils/errorTracking.ts', 'isRecoverableError', {
    isChunkLoadError: () => false, document: { body: null },
  });
  assert.equal(isRecoverable(new TypeError('Cannot read properties of null'), true), true);
});

test('une erreur globale sur document détaché reste visible faute de récupération React', () => {
  const isRecoverable = sourceFunction('src/utils/errorTracking.ts', 'isRecoverableError', {
    isChunkLoadError: () => false, document: { body: null },
  });
  assert.equal(isRecoverable(new TypeError('Cannot read properties of null')), false);
});

test('un document intact conserve les vraies erreurs de code', () => {
  const isRecoverable = sourceFunction('src/utils/errorTracking.ts', 'isRecoverableError', {
    isChunkLoadError: () => false, document: { body: {} },
  });
  assert.equal(isRecoverable(new TypeError('Cannot read properties of null')), false);
});

test('seules les signatures injectées connues et automatiques sont exclues', () => {
  const isInjected = sourceFunction('src/utils/errorTracking.ts', 'isInjectedBrowserError');
  const event = (value: string, handled = false) => ({ exception: { values: [{ value, mechanism: { handled } }] } });
  for (const message of ["undefined is not an object (evaluating 'this.blobUrls[0].start')", "Can't find variable: logMutedMessage", "Can't create duplicate variable: 'MinHeightToDisplayTitle'", "undefined is not an object (evaluating 'window.webkit.messageHandlers')"]) {
    assert.equal(isInjected(event(message)), true, message);
    assert.equal(isInjected(event(message, true)), false, 'les captures explicites restent visibles');
  }
  assert.equal(isInjected(event("Can't find variable: msg")), false, 'une variable générique ne prouve pas une injection');
  assert.equal(isInjected(event('Cannot read properties of null')), false);
});

const OWN = 'https://movix.test/assets/index-AbCdEf12.js';
const ownBundle = /^https:\/\/movix\.test\/assets\/[^/?#]+-[A-Za-z0-9_-]{8}\.js(?:[?#]|$)/;
const frame = (filename: string, lineno?: number) => ({ filename, lineno });
const isNativeFrame = sourceFunction('src/utils/errorTracking.ts', 'isNativeFrame');
const lastValue = sourceFunction('src/utils/errorTracking.ts', 'lastValue');

test('les cadres <anonymous> sans ligne sont natifs, avec une ligne ils sont du code injecté', () => {
  assert.equal(isNativeFrame(frame('<anonymous>')), true);
  assert.equal(isNativeFrame(frame('<anonymous>', 1)), false);
  assert.equal(isNativeFrame(frame('[native code]')), true);
  assert.equal(isNativeFrame(frame(OWN, 1)), false);
});

test('une erreur globale sans aucun cadre Movix est jetée, une erreur de nos chunks reste visible', () => {
  const hasNoOwnFrame = sourceFunction('src/utils/errorTracking.ts', 'hasNoOwnFrame', { lastValue });
  const event = (frames: object[], handled = false) => ({ exception: { values: [{ mechanism: { handled }, stacktrace: { frames } }] } });
  assert.equal(hasNoOwnFrame(event([]), ownBundle), true, 'rejet sans pile (app hôte, extension)');
  assert.equal(hasNoOwnFrame(event([frame('[native code]')]), ownBundle), true);
  assert.equal(hasNoOwnFrame(event([frame(OWN, 3)]), ownBundle), false);
  assert.equal(hasNoOwnFrame(event([], true), ownBundle), false, 'les captures explicites restent visibles');
  assert.equal(hasNoOwnFrame(event([frame('https://movix.test/assets/vendor.js', 1)]), ownBundle), true, 'un fichier sans hash n’est pas un chunk du build');
});

test('un callback enveloppé dont seul le wrapper du SDK apparaît vient d’un script invisible', () => {
  const isInvisible = sourceFunction('src/utils/errorTracking.ts', 'isWrappedInvisibleCallback', { lastValue, isNativeFrame });
  const event = (frames: object[], type = 'auto.browser.browserapierrors.setTimeout') => ({
    exception: { values: [{ mechanism: { handled: false, type }, stacktrace: { frames } }] },
  });
  assert.equal(isInvisible(event([frame(OWN, 41), frame('[native code]')])), true);
  assert.equal(isInvisible(event([frame(OWN, 41), frame(OWN, 411)])), false, 'notre callback laisse son propre cadre');
  assert.equal(isInvisible(event([frame(OWN, 41)], 'auto.browser.global_handlers.onerror')), false);
});

test('un crash ErrorBoundary entièrement dans un script injecté est jeté, pas s’il passe par nos chunks', () => {
  const isForeign = sourceFunction('src/utils/errorTracking.ts', 'isBoundaryErrorThrownByForeignCode', { isNativeFrame });
  const event = (frames: object[]) => ({
    exception: {
      values: [
        { type: 'React ErrorBoundary RangeError', mechanism: { type: 'auto.function.react.error_boundary' }, stacktrace: { frames: [frame(OWN, 9)] } },
        { type: 'RangeError', mechanism: { type: 'generic' }, stacktrace: { frames } },
      ],
    },
  });
  assert.equal(isForeign(event([frame('<anonymous>', 1), frame('<anonymous>', 1)]), ownBundle), true, 'récursion injectée');
  assert.equal(isForeign(event([frame(OWN, 2), frame('<anonymous>', 14)]), ownBundle), false, 'polyfill de la plateforme appelé par Movix');
  assert.equal(isForeign(event([frame('[native code]')]), ownBundle), false);
});

const loadChunkErrorDetection = () => {
  const file = 'src/routing/lazyWithRetry.ts';
  const CORRUPTED_CHUNK_MESSAGES = sourceFunction(file, 'CORRUPTED_CHUNK_MESSAGES');
  const isLazyCompileError = sourceFunction(file, 'isLazyCompileError', {
    LAZY_COMPILE_ERROR_PATTERN: sourceFunction(file, 'LAZY_COMPILE_ERROR_PATTERN'),
    HASHED_JS_ASSET_PATTERN: sourceFunction(file, 'HASHED_JS_ASSET_PATTERN'),
    window: { location: { origin: 'https://movix.test' } },
  });
  const isCorruptedChunkError = sourceFunction(file, 'isCorruptedChunkError', { CORRUPTED_CHUNK_MESSAGES, isLazyCompileError });
  const isChunkResponseError = sourceFunction(file, 'isChunkResponseError', { isCorruptedChunkError });
  return {
    isChunkResponseError,
    isChunkLoadError: sourceFunction(file, 'isChunkLoadError', {
      isChunkResponseError,
      SYSTEMJS_LOAD_ERROR_PATTERN: sourceFunction(file, 'SYSTEMJS_LOAD_ERROR_PATTERN'),
      IMPORT_NETWORK_ERROR_PATTERNS: sourceFunction(file, 'IMPORT_NETWORK_ERROR_PATTERNS'),
    }),
  };
};

const syntaxError = (message: string) => Object.assign(new Error(message), { name: 'SyntaxError' });

test('SystemJS #3 et le refus CORS de Safari sont des échecs de chargement, pas des crashs', () => {
  const { isChunkLoadError } = loadChunkErrorDetection();
  assert.equal(isChunkLoadError(new Error('https://movix.test/assets/WatchTv-legacy-BtxG_s7l.js, (SystemJS https://github.com/systemjs/systemjs/blob/main/docs/errors.md#3)')), true);
  assert.equal(isChunkLoadError(new Error('https://movix.test/assets/popcorn-legacy-1Pz-aL03.js, https://movix.test/assets/detailCharacters-legacy-D2kcG1rU.js (SystemJS https://github.com/systemjs/systemjs/blob/main/docs/errors.md#3)')), true);
  assert.equal(isChunkLoadError(Object.assign(new Error('Cross-origin script load denied by Cross-Origin Resource Sharing policy.'), { name: 'TypeError' })), true);
  assert.equal(isChunkLoadError(new Error('x (SystemJS https://github.com/systemjs/systemjs/blob/main/docs/errors.md#2)')), false, 'un module non instancié reste visible');
});

test('un chunk tronqué déclenche la purge du cache, une vraie erreur de syntaxe reste visible', () => {
  const { isChunkLoadError, isChunkResponseError } = loadChunkErrorDetection();
  for (const message of ['Unexpected end of script', 'Unexpected EOF', "Invalid character: '\\0'", 'Invalid or unexpected token', 'Unexpected end of input']) {
    assert.equal(isChunkResponseError(syntaxError(message)), true, message);
    assert.equal(isChunkLoadError(syntaxError(message)), true, message);
  }
  assert.equal(isChunkLoadError(syntaxError('Invalid regular expression: invalid group specifier name')), false);
  assert.equal(isChunkLoadError(syntaxError("Unexpected identifier 'as'")), false);
  assert.equal(isChunkLoadError(new Error('Unexpected end of script')), false, 'seul un SyntaxError du moteur compte');
});

test('une erreur d’analyse levée depuis un de nos chunks déjà exécutés désigne un cache abîmé', () => {
  const { isChunkLoadError, isChunkResponseError } = loadChunkErrorDetection();
  const withStack = (message: string, frames: string[]) => Object.assign(syntaxError(message), {
    stack: [`SyntaxError: ${message}`, ...frames.map((frame) => `    at ${frame}`)].join('\n'),
  });
  // Pile réelle de FRONTEND-F3 (Opera 136) : TooltipProvider ne compile pas.
  const f3 = withStack("Unexpected identifier 'u'", [
    'Bo (https://movix.test/assets/react-vendor-DEJwnf9Q.js:6:16873)',
    'Ul (https://movix.test/assets/react-vendor-DEJwnf9Q.js:8:43540)',
  ]);
  assert.equal(isChunkResponseError(f3), true, 'purge du cache puis rechargement');
  assert.equal(isChunkLoadError(f3), true);
  assert.equal(isChunkLoadError(withStack('Unexpected identifier', ['https://movix.test/assets/index-AbCdEf12.js:1:20'])), true);

  assert.equal(isChunkLoadError(withStack("Unexpected identifier 'as'", [])), false, 'échec au chargement : incompatibilité possible');
  assert.equal(isChunkLoadError(withStack("Unexpected identifier 'u'", ['eval (eval at run (https://ext.test/inject.js:1:5), <anonymous>:1:3)'])), false);
  assert.equal(isChunkLoadError(withStack("Unexpected identifier 'u'", ['x (https://autre.test/assets/index-AbCdEf12.js:1:2)'])), false, 'autre origine');
  assert.equal(isChunkLoadError(withStack("Unexpected identifier 'u'", ['x (https://movix.test/assets/vendor.js:1:2)'])), false, 'fichier sans hash');
  assert.equal(isChunkLoadError(withStack("Failed to execute 'querySelector' on 'Document': 'a[' is not a valid selector.", [
    'q (https://movix.test/assets/index-AbCdEf12.js:3:4)',
  ])), false, 'un sélecteur invalide reste un bug visible');
});
