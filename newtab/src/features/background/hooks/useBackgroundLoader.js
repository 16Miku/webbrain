import { useCallback, useEffect, useRef } from 'react';
import { getBackgroundData } from '../api/backgroundLoader';

/**
 * Hook for loading and refreshing background data
 */
export function useBackgroundLoader(updateBackground, resetBackground) {
  // Latest request wins. Skipping a request while another is running would drop a
  // refresh asked for mid-load (e.g. switching to a colour while an IndexedDB read
  // is pending) and the stale result would be applied after resetBackground().
  const requestRef = useRef(0);

  const loadBackground = useCallback(async () => {
    const request = ++requestRef.current;
    const isStale = () => request !== requestRef.current;

    try {
      // Check for welcome tab first
      const welcomeTab = localStorage.getItem('welcomeTab');
      if (welcomeTab) {
        const welcomeImage = localStorage.getItem('welcomeImage');
        if (welcomeImage) {
          updateBackground(JSON.parse(welcomeImage));
          return;
        }
      }

      const data = await getBackgroundData();
      if (isStale()) return;
      if (data) {
        updateBackground(data);
      }
    } catch (error) {
      console.error('Failed to load background:', error);
    }
  }, [updateBackground]);

  const refreshBackground = useCallback(() => {
    resetBackground();
    loadBackground();
  }, [loadBackground, resetBackground]);

  // Initial load - only run once on mount
  useEffect(() => {
    const changeMode = localStorage.getItem('backgroundchange');
    const hasStartTime = localStorage.getItem('backgroundStartTime');

    if (!hasStartTime || changeMode === 'refresh') {
      localStorage.setItem('backgroundStartTime', Date.now());
    }

    loadBackground();
  }, [loadBackground]);

  return { loadBackground, refreshBackground };
}
