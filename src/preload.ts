import { contextBridge, ipcRenderer } from 'electron';
import type { TrackInfo, TrackUpdateReason } from './types';

contextBridge.exposeInMainWorld('soundcloudAPI', {
    sendTrackUpdate: (data: TrackInfo, reason: TrackUpdateReason) => {
        ipcRenderer.send('soundcloud:track-update', {
            data,
            reason,
        });
    },
    getTrackOverrideAudio: (trackUrl: string) => {
        return ipcRenderer.invoke('track-override:get-audio', trackUrl);
    },
    getTrackOverrideInfo: (trackUrl: string) => {
        return ipcRenderer.invoke('track-override:get-info', trackUrl);
    },
    startTrackOverride: (
        trackUrl: string,
        state: { position: number; volume: number; isPlaying: boolean },
    ) => {
        return ipcRenderer.invoke('track-override:start', trackUrl, state);
    },
    updateTrackOverride: (state: { position: number; volume: number; isPlaying: boolean }) => {
        ipcRenderer.invoke('track-override:update', state);
    },
    stopTrackOverride: () => {
        ipcRenderer.invoke('track-override:stop');
    },
    onTrackOverrideChanged: (callback: (trackUrl: string) => void) => {
        ipcRenderer.on('track-override:changed', (_event, trackUrl: string) => {
            callback(trackUrl);
        });
    },
    onTrackOverrideStatus: (
        callback: (status: {
            trackUrl: string;
            position: number;
            duration: number;
            isPlaying: boolean;
            ended: boolean;
        }) => void,
    ) => {
        ipcRenderer.on('track-override:status', (_event, status) => {
            callback(status);
        });
    },
});
