import React, { createContext, useContext, useState, useCallback, useMemo } from 'react';

interface AdWarningContextType {
  showAdWarning: boolean;
  setShowAdWarning: (show: boolean) => void;
  handleAccept: () => void;
}

const AdWarningContext = createContext<AdWarningContextType | undefined>(undefined);

export const AdWarningProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  // Désactivé par défaut
  const [showAdWarning, setShowAdWarning] = useState(false);

  const handleAccept = useCallback(() => {
    setShowAdWarning(false);
  }, []);

  const value = useMemo(
    () => ({ showAdWarning: false, setShowAdWarning, handleAccept }),
    [setShowAdWarning, handleAccept]
  );

  return (
    <AdWarningContext.Provider value={value}>
      {children}
    </AdWarningContext.Provider>
  );
};

export const useAdWarning = () => {
  const context = useContext(AdWarningContext);
  if (context === undefined) {
    throw new Error('useAdWarning must be used within an AdWarningProvider');
  }
  return context;
};
