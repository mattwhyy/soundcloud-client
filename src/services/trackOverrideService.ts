/**
 * Renderer-side local track override playback.
 *
 * The SoundCloud track remains the authoritative queue/metadata entry. When a
 * saved override exists, the original stream keeps driving SoundCloud's UI and
 * queue while its audio is muted and a local file is played in sync.
 */
export const trackOverrideScript = \`
(function() {
    if (window.__soundcloudTrackOverridesLoaded) return;
    window.__soundcloudTrackOverridesLoaded = true;

    let currentTrackUrl = '';
    let localAudio = null;
    let localObjectUrl = null;
    let sourceAudio = null;
    let sourceAudioWasMuted = false;
    let activationToken = 0;

    function normalizeUrl(value) {
        if (!value) return '';
        try {
            const parsed = new URL(value, window.location.origin);
            parsed.search = '';
            parsed.hash = '';
            return parsed.origin + parsed.pathname.replace(/\\\\/+$/, '');
        } catch (_) {
            return String(value).split('?')[0].split('#')[0].replace(/\\\\/+$/, '');
        }
    }

    function getCurrentTrackUrl() {
        const link = document.querySelector('.playbackSoundBadge__titleLink');
        return normalizeUrl(link && link.href ? link.href : '');
    }

    function isSoundCloudPlaying() {
        const playButton = document.querySelector('.playControls__play');
        return Boolean(playButton && playButton.classList.contains('playing'));
    }

    function getSoundCloudAudio() {
        const audios = Array.from(document.querySelectorAll('audio'));
        return audios.find(audio => audio !== localAudio) || null;
    }

    function parseTime(value) {
        if (!value) return 0;
        return String(value)
            .split(':')
            .map(part => Number(part) || 0)
            .reduce((total, part) => total * 60 + part, 0);
    }

    function getSoundCloudPosition() {
        if (sourceAudio && Number.isFinite(sourceAudio.currentTime)) {
            return sourceAudio.currentTime;
        }

        const elapsed = document.querySelector('.playbackTimeline__timePassed span:last-child');
        return parseTime(elapsed ? elapsed.textContent : '');
    }

    function restoreSourceAudio() {
        if (sourceAudio) {
            try {
                sourceAudio.muted = sourceAudioWasMuted;
            } catch (_) {}
        }
        sourceAudio = null;
        sourceAudioWasMuted = false;
    }

    function stopLocalOverride() {
        activationToken++;

        if (localAudio) {
            try {
                localAudio.pause();
                localAudio.src = '';
            } catch (_) {}
        }

        localAudio = null;
        restoreSourceAudio();

        if (localObjectUrl) {
            try {
                URL.revokeObjectURL(localObjectUrl);
            } catch (_) {}
        }
        localObjectUrl = null;
    }

    function attachSourceAudio() {
        const nextSourceAudio = getSoundCloudAudio();
        if (!nextSourceAudio) return;

        if (sourceAudio !== nextSourceAudio) {
            restoreSourceAudio();
            sourceAudio = nextSourceAudio;
            sourceAudioWasMuted = sourceAudio.muted;
        }

        // Keep SoundCloud running normally for queue state, metadata, seeking,
        // keyboard controls and Media Session, but silence its actual stream.
        sourceAudio.muted = true;

        if (localAudio) {
            localAudio.volume = sourceAudioWasMuted ? 0 : Math.max(0, Math.min(1, sourceAudio.volume));
        }
    }

    async function activateOverride(trackUrl) {
        const myToken = ++activationToken;
        stopLocalOverride();
        currentTrackUrl = normalizeUrl(trackUrl);

        if (!currentTrackUrl || !window.soundcloudAPI?.getTrackOverrideAudio) {
            return;
        }

        let override;
        try {
            override = await window.soundcloudAPI.getTrackOverrideAudio(currentTrackUrl);
        } catch (error) {
            console.error('[SoundCloud] Could not load local track override:', error);
            return;
        }

        if (myToken !== activationToken || !override || !override.data) {
            return;
        }

        try {
            let bytes;
            if (override.data instanceof ArrayBuffer) {
                bytes = new Uint8Array(override.data);
            } else if (ArrayBuffer.isView(override.data)) {
                bytes = new Uint8Array(
                    override.data.buffer,
                    override.data.byteOffset || 0,
                    override.data.byteLength
                );
            } else {
                bytes = new Uint8Array(override.data);
            }

            const blob = new Blob([bytes], {
                type: override.mimeType || 'application/octet-stream'
            });

            localObjectUrl = URL.createObjectURL(blob);
            localAudio = new Audio(localObjectUrl);
            localAudio.preload = 'auto';
            localAudio.dataset.soundcloudLocalOverride = 'true';

            attachSourceAudio();

            const syncInitialPosition = () => {
                if (!localAudio) return;
                const position = getSoundCloudPosition();
                if (Number.isFinite(position) && position >= 0) {
                    try {
                        localAudio.currentTime = Math.min(position, localAudio.duration || position);
                    } catch (_) {}
                }

                if (isSoundCloudPlaying()) {
                    localAudio.play().catch(error => {
                        console.debug('[SoundCloud] Local override play was deferred:', error);
                    });
                }
            };

            if (localAudio.readyState >= 1) {
                syncInitialPosition();
            } else {
                localAudio.addEventListener('loadedmetadata', syncInitialPosition, { once: true });
            }

            console.log(
                '[SoundCloud] Playing local override for',
                currentTrackUrl,
                '(' + (override.fileName || 'local file') + ')'
            );
        } catch (error) {
            console.error('[SoundCloud] Failed to initialize local track override:', error);
            stopLocalOverride();
        }
    }

    async function refreshCurrentTrack(force) {
        const nextUrl = getCurrentTrackUrl();
        if (!nextUrl) {
            if (currentTrackUrl) {
                currentTrackUrl = '';
                stopLocalOverride();
            }
            return;
        }

        if (force || nextUrl !== currentTrackUrl) {
            await activateOverride(nextUrl);
        }
    }

    // SoundCloud remains the transport/queue authority. Mirror its current
    // playback state, seek position and volume to the local file.
    setInterval(() => {
        const nextUrl = getCurrentTrackUrl();

        if (nextUrl !== currentTrackUrl) {
            refreshCurrentTrack(false);
            return;
        }

        if (!localAudio) return;

        attachSourceAudio();

        const shouldPlay = isSoundCloudPlaying();
        if (shouldPlay && localAudio.paused && !localAudio.ended) {
            localAudio.play().catch(() => {});
        } else if (!shouldPlay && !localAudio.paused) {
            localAudio.pause();
        }

        const targetPosition = getSoundCloudPosition();
        if (
            Number.isFinite(targetPosition) &&
            Number.isFinite(localAudio.currentTime) &&
            Math.abs(localAudio.currentTime - targetPosition) > 1.25
        ) {
            try {
                localAudio.currentTime = Math.min(
                    targetPosition,
                    Number.isFinite(localAudio.duration) ? localAudio.duration : targetPosition
                );
            } catch (_) {}
        }
    }, 250);

    if (window.soundcloudAPI?.onTrackOverrideChanged) {
        window.soundcloudAPI.onTrackOverrideChanged(changedUrl => {
            const normalized = normalizeUrl(changedUrl);
            if (normalized && normalized === getCurrentTrackUrl()) {
                refreshCurrentTrack(true);
            }
        });
    }

    const observer = new MutationObserver(() => {
        const nextUrl = getCurrentTrackUrl();
        if (nextUrl && nextUrl !== currentTrackUrl) {
            refreshCurrentTrack(false);
        }
    });

    observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['href']
    });

    window.addEventListener('beforeunload', () => {
        observer.disconnect();
        stopLocalOverride();
    });

    refreshCurrentTrack(false);
})();
\`;
