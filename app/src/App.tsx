import React, { useEffect, useState } from 'react';
import {
  AppState,
  StatusBar,
  Alert,
  NativeModules,
  Platform,
} from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';

import BrowserScreen from './screens/BrowserScreen';
import UpdateScreen from './screens/UpdateScreen';
import UpdateDialog from './components/UpdateDialog';
import { useAppUpdate } from './hooks/useAppUpdate';
import { AddressProvider, useAddress } from './context/AddressContext';
import { loadNetworkJournalPreference } from './services/networkJournal';

const { DnsModule } = NativeModules;

// Plafond d'attente du VPN au démarrage : si Android redemande l'accord VPN,
// l'app ne reste pas bloquée derrière la boîte de dialogue.
const DNS_START_WAIT_MS = 6000;

function waitAtMost<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([
    promise,
    new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), ms)),
  ]);
}

function promptDns() {
  Alert.alert(
    'DNS Cloudflare 1.1.1.1',
    'Activer le DNS Cloudflare pour une navigation plus rapide et sécurisée ?\n\n(Recommandé)',
    [
      {
        text: 'Non merci',
        style: 'cancel',
        onPress: () => {
          AsyncStorage.setItem('dns_enabled', 'false');
        },
      },
      {
        text: 'Activer',
        style: 'default',
        onPress: async () => {
          try {
            if (!DnsModule) {
              await AsyncStorage.setItem('dns_enabled', 'false');
              return;
            }

            if (Platform.OS === 'ios') {
              const dnsActivated = await DnsModule.enable('1.1.1.1', '1.0.0.1');
              await AsyncStorage.setItem('dns_enabled', dnsActivated ? 'true' : 'false');
              if (!dnsActivated) {
                Alert.alert(
                  'Activation DNS requise',
                  'La configuration est installée. Active-la manuellement dans Réglages > Général > VPN et gestion de l’appareil > DNS.',
                  [{ text: 'Compris' }],
                );
              }
            } else {
              await DnsModule.enable('1.1.1.1', '1.0.0.1');
              await AsyncStorage.setItem('dns_enabled', 'true');
            }
          } catch {
            await AsyncStorage.setItem('dns_enabled', 'false');
          }
        },
      },
    ],
  );
}

export default function App() {
  const [ready, setReady] = useState(false);
  const [dnsSettled, setDnsSettled] = useState(false);

  // Le tampon natif du journal réseau part éteint à chaque démarrage : sans ce
  // rappel au boot, la capture ne reprenait qu'en ouvrant les réglages, et une
  // lecture lancée juste après une mise à jour n'était pas enregistrée — soit
  // exactement le moment où on a besoin d'elle.
  useEffect(() => {
    loadNetworkJournalPreference().catch(() => {});
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const stored = await AsyncStorage.getItem('dns_enabled');
        let nativeEnabled = false;
        if (DnsModule) {
          try {
            nativeEnabled = await DnsModule.isEnabled();
          } catch {}
        }

        if (nativeEnabled) {
          if (stored !== 'true') {
            await AsyncStorage.setItem('dns_enabled', 'true');
          }
          setDnsSettled(true);
        } else if (stored === 'true' && DnsModule && Platform.OS === 'android') {
          // Monter le VPN AVANT de charger Movix : lancé en parallèle, le
          // changement de réseau coupait la récupération des domaines et la
          // première page, et l'app affichait « Movix injoignable ».
          await waitAtMost(
            DnsModule.enable('1.1.1.1', '1.0.0.1').catch(() => {}),
            DNS_START_WAIT_MS,
          );
          setDnsSettled(true);
        } else if (stored === 'true') {
          await AsyncStorage.setItem('dns_enabled', 'false');
          setDnsSettled(true);
        } else if (stored === null) {
          promptDns();
          // Mark settled on next tick — we don't block on user's DNS answer.
          // The update check is cheap and will still run after; its dialog
          // stacks on top of the DNS prompt on Android without issue now
          // that it's a proper Modal, not Alert.alert.
          setDnsSettled(true);
        } else {
          setDnsSettled(true);
        }
      } finally {
        setReady(true);
      }
    })();
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'ios' || !DnsModule) return undefined;

    const syncDnsState = async () => {
      try {
        const active = await DnsModule.isEnabled();
        await AsyncStorage.setItem('dns_enabled', active ? 'true' : 'false');
      } catch {}
    };
    const subscription = AppState.addEventListener('change', nextState => {
      if (nextState === 'active') {
        void syncDnsState();
      }
    });
    return () => subscription.remove();
  }, []);

  if (!ready) return null;

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" backgroundColor="#0a0a0a" />
      <AddressProvider>
        <AppShell dnsSettled={dnsSettled} />
      </AddressProvider>
    </SafeAreaProvider>
  );
}

function AppShell({ dnsSettled }: { dnsSettled: boolean }) {
  const { config } = useAddress();
  const { state, accept, dismiss, cancel, openSettings, retry } = useAppUpdate(
    config?.githubUrl ?? null,
  );

  // No i18n in the mobile app today — FR is the primary language. The JSON
  // manifest still carries both `fr` and `en` release notes for future use.
  const locale: 'fr' | 'en' = 'fr';

  const showScreen =
    state.manifest &&
    (state.stage === 'downloading' ||
      state.stage === 'verifying' ||
      state.stage === 'installing' ||
      state.stage === 'need_permission' ||
      state.stage === 'error');

  if (showScreen && state.manifest) {
    return (
      <UpdateScreen
        manifest={state.manifest}
        stage={state.stage}
        progress={state.progress}
        error={state.error}
        locale={locale}
        onCancel={cancel}
        onOpenSettings={openSettings}
        onRetry={retry}
      />
    );
  }

  return (
    <>
      <BrowserScreen />
      {dnsSettled && state.stage === 'offered' && state.manifest && (
        <UpdateDialog
          manifest={state.manifest}
          locale={locale}
          onLater={dismiss}
          onUpdate={accept}
        />
      )}
    </>
  );
}
