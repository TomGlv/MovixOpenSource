import React, { createContext, useContext, useState, useCallback, useMemo } from 'react';

interface AdFreePopupContextType {
  showAdFreePopup: boolean;
  adType: 'ad1' | 'ad2';
  playerToShow: string | null;
  shouldLoadIframe: boolean;
  isSpecialPlayer: boolean;
  isVoVostfrOnly: boolean;
  is_vip: boolean;
  showPopupForPlayer: (playerType: string, additionalInfo?: any) => void;
  handlePopupClose: () => void;
  handlePopupAccept: () => void;
  resetVipStatus: () => void;
}

const AdFreePopupContext = createContext<AdFreePopupContextType | undefined>(undefined);

export const AdFreePopupProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [showAdFreePopup] = useState(false);
  const [adType] = useState<'ad1' | 'ad2'>('ad2');
  const [playerToShow, setPlayerToShow] = useState<string | null>(null);
  const [shouldLoadIframe, setShouldLoadIframe] = useState(true);
  const [isSpecialPlayer] = useState(false);
  const [isVoVostfrOnly] = useState(false);
  const [is_vip, setIsVip] = useState(true); // Forcé à VIP par défaut

  const showPopupForPlayer = useCallback((playerType: string) => {
    // Ne déclenche jamais la popup et débloque le lecteur immédiatement
    setIsVip(true);
    setShouldLoadIframe(true);
    setPlayerToShow(playerType);
  }, []);

  const handlePopupClose = useCallback(() => {}, []);
  const handlePopupAccept = useCallback(() => {}, []);
  const resetVipStatus = useCallback(() => {}, []);

  const value = useMemo<AdFreePopupContextType>(() => ({
    showAdFreePopup: false,
    adType,
    playerToShow,
    shouldLoadIframe: true,
    isSpecialPlayer,
    isVoVostfrOnly,
    is_vip: true,
    showPopupForPlayer,
    handlePopupClose,
    handlePopupAccept,
    resetVipStatus
  }), [
    adType,
    playerToShow,
    isSpecialPlayer,
    isVoVostfrOnly,
    showPopupForPlayer,
    handlePopupClose,
    handlePopupAccept,
    resetVipStatus
  ]);

  return (
    <AdFreePopupContext.Provider value={value}>
      {children}
    </AdFreePopupContext.Provider>
  );
};

export const useAdFreePopup = () => {
  const context = useContext(AdFreePopupContext);
  if (context === undefined) {
    throw new Error('useAdFreePopup must be used within an AdFreePopupProvider');
  }
  return context;
};
