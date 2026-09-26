/**
 * Fixes SoundCloud's web player shuffle behavior for large collections.
 *
 * Queue loading adapted from iamnotbobby's MIT-licensed shuffle-fix plugin:
 * https://github.com/iamnotbobby/soundcloud-rpc/blob/main/plugins/shuffle-fix.js
 *
 * Fair round behavior is inspired by mrketa's MIT-licensed SoundCloud True
 * Shuffle project, which uses a Fisher-Yates round so every track gets a turn
 * before a fresh order is generated:
 * https://github.com/mrketa/soundcloud-true-shuffle
 *
 * SoundCloud normally shuffles only the portion of the queue that has already
 * been paginated into memory. This script patches the player queue so that,
 * when shuffle is enabled, the remaining pages are pulled in controlled
 * batches first and the complete queue is then shuffled.
 *
 * This intentionally uses moderate batch sizes to reduce UI stalls and memory
 * spikes on very large liked-track collections/playlists.
 */
export const shuffleFixScript = `
(function() {
    if (window.__soundcloudClientShuffleFixLoaded) return;
    window.__soundcloudClientShuffleFixLoaded = true;

    const MAX_LIMIT = 250;
    const BATCH_SIZE = 50;
    const POLL_DELAY_MS = 150;
    const MAX_STALLED_CYCLES = 33;
    const MAX_LOAD_TIME_MS = 60000;
    const RECENT_HISTORY_SIZE = 50;
    const PATCH_RESCAN_MS = 1000;
    const PATCH_RESCAN_ATTEMPTS = 120;

    let recentTrackUrls = [];
    try {
        const saved = JSON.parse(sessionStorage.getItem('soundcloud-client-shuffle-history') || '[]');
        if (Array.isArray(saved)) {
            recentTrackUrls = saved.filter(value => typeof value === 'string').slice(-RECENT_HISTORY_SIZE);
        }
    } catch (_) {}

    function normalizeUrl(value) {
        if (!value) return '';

        try {
            const parsed = new URL(value, window.location.origin);
            parsed.search = '';
            parsed.hash = '';
            return parsed.origin + parsed.pathname.replace(/\\/+$/, '');
        } catch (_) {
            return String(value).split('?')[0].split('#')[0].replace(/\\/+$/, '');
        }
    }

    function getCurrentTrackUrl() {
        const link = document.querySelector('.playbackSoundBadge__titleLink');
        return normalizeUrl(link && link.href ? link.href : '');
    }

    function rememberTrack(url) {
        const normalized = normalizeUrl(url);
        if (!normalized) return;

        recentTrackUrls = recentTrackUrls.filter(value => value !== normalized);
        recentTrackUrls.push(normalized);

        if (recentTrackUrls.length > RECENT_HISTORY_SIZE) {
            recentTrackUrls.splice(0, recentTrackUrls.length - RECENT_HISTORY_SIZE);
        }

        try {
            sessionStorage.setItem(
                'soundcloud-client-shuffle-history',
                JSON.stringify(recentTrackUrls)
            );
        } catch (_) {}
    }

    function fisherYates(values) {
        const shuffled = values.slice();

        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            const tmp = shuffled[i];
            shuffled[i] = shuffled[j];
            shuffled[j] = tmp;
        }

        return shuffled;
    }

    function readModelValue(model, key) {
        if (!model) return undefined;

        try {
            if (typeof model.get === 'function') {
                const value = model.get(key);
                if (value !== undefined && value !== null) return value;
            }
        } catch (_) {}

        if (model.attributes && model.attributes[key] !== undefined) {
            return model.attributes[key];
        }

        return model[key];
    }

    function getModelUrl(model) {
        const directKeys = [
            'permalink_url',
            'permalinkUrl',
            'url',
            'uri',
            'track_url',
            'trackUrl',
        ];

        for (const key of directKeys) {
            const value = readModelValue(model, key);
            if (typeof value === 'string' && value) {
                if (value.startsWith('/')) {
                    return normalizeUrl('https://soundcloud.com' + value);
                }

                if (value.includes('soundcloud.com')) {
                    return normalizeUrl(value);
                }
            }
        }

        const permalink = readModelValue(model, 'permalink');
        const user = readModelValue(model, 'user');
        const username =
            user && (
                (typeof user.get === 'function' && user.get('permalink')) ||
                user.permalink ||
                user.attributes?.permalink
            );

        if (username && permalink) {
            return normalizeUrl('https://soundcloud.com/' + username + '/' + permalink);
        }

        return '';
    }

    function getQueueModels(queue) {
        if (!queue) return null;
        if (Array.isArray(queue.models)) return queue.models;
        if (Array.isArray(queue.items)) return queue.items;
        if (Array.isArray(queue._items)) return queue._items;
        if (Array.isArray(queue)) return queue;
        return null;
    }

    function applyFairShuffle(queue) {
        const models = getQueueModels(queue);
        if (!models || models.length < 2) {
            console.warn('[SoundCloud Client] Queue shape did not expose reorderable tracks');
            return false;
        }

        const currentUrl = getCurrentTrackUrl();
        let currentIndex = currentUrl
            ? models.findIndex(model => getModelUrl(model) === currentUrl)
            : -1;

        // Keeping everything through the current item in place avoids breaking
        // SoundCloud's current queue pointer/history. Only upcoming tracks move.
        if (currentIndex < 0) {
            currentIndex = 0;
        }

        const prefix = models.slice(0, currentIndex + 1);
        const upcoming = models.slice(currentIndex + 1);

        if (upcoming.length < 2) return true;

        const recent = new Set(recentTrackUrls);
        const freshTracks = [];
        const recentlyPlayedTracks = [];

        for (const model of upcoming) {
            const url = getModelUrl(model);
            if (url && recent.has(url)) {
                recentlyPlayedTracks.push(model);
            } else {
                freshTracks.push(model);
            }
        }

        // A full Fisher-Yates round means every upcoming track appears exactly
        // once. Recent tracks are still included, just pushed later in the
        // round so toggling shuffle doesn't immediately replay the same songs.
        const shuffledUpcoming = fisherYates(freshTracks).concat(
            fisherYates(recentlyPlayedTracks)
        );

        models.splice(0, models.length, ...prefix, ...shuffledUpcoming);

        try {
            if (typeof queue.trigger === 'function') {
                queue.trigger('sort', queue, { soundcloudClientShuffle: true });
            }
        } catch (_) {}

        console.log(
            '[SoundCloud Client] Fair shuffle applied:',
            shuffledUpcoming.length,
            'upcoming tracks; recent tracks delayed:',
            recentlyPlayedTracks.length
        );

        return true;
    }

    let lastObservedTrackUrl = '';
    const historyObserver = new MutationObserver(() => {
        const currentUrl = getCurrentTrackUrl();
        if (currentUrl && currentUrl !== lastObservedTrackUrl) {
            lastObservedTrackUrl = currentUrl;
            rememberTrack(currentUrl);
        }
    });

    historyObserver.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['href'],
    });

    const initialTrackUrl = getCurrentTrackUrl();
    if (initialTrackUrl) {
        lastObservedTrackUrl = initialTrackUrl;
        rememberTrack(initialTrackUrl);
    }

    function findWebpackRequire() {
        if (typeof window.webpackJsonp !== 'undefined') {
            let requireFunc = null;
            window.webpackJsonp.push([
                [],
                {
                    '__soundcloud_client_shuffle_fix__': function(module, exports, __webpack_require__) {
                        requireFunc = __webpack_require__;
                    }
                },
                [['__soundcloud_client_shuffle_fix__']]
            ]);
            return requireFunc;
        }

        for (const key in window) {
            if (!key.startsWith('webpackChunk')) continue;

            const chunk = window[key];
            if (!Array.isArray(chunk)) continue;

            let requireFunc = null;
            chunk.push([
                ['__soundcloud_client_shuffle_fix__'],
                {
                    '__soundcloud_client_shuffle_fix__': function(module, exports, __webpack_require__) {
                        requireFunc = __webpack_require__;
                    }
                },
                [['__soundcloud_client_shuffle_fix__']]
            ]);

            if (requireFunc) return requireFunc;
        }

        return null;
    }

    function patchModules(webpackRequire) {
        const cache = webpackRequire?.c || {};
        let patchedCount = 0;

        for (const moduleId in cache) {
            try {
                const moduleExports = cache[moduleId]?.exports;

                if (moduleExports?.prototype) {
                    const proto = moduleExports.prototype;

                    if (proto.defaults?.limit !== undefined) {
                        proto.defaults.limit = MAX_LIMIT;
                        proto.defaults.maxPageSize = MAX_LIMIT;
                    }

                    if (typeof proto.setLimit === 'function' && !proto.setLimit.__soundcloudClientPatched) {
                        const originalSetLimit = proto.setLimit;

                        proto.setLimit = function(limit) {
                            return originalSetLimit.call(this, Math.max(limit, MAX_LIMIT));
                        };

                        proto.setLimit.__soundcloudClientPatched = true;
                    }
                }

                if (
                    typeof moduleExports?.toggleShuffle === 'function' &&
                    typeof moduleExports?.getQueue === 'function' &&
                    !moduleExports.toggleShuffle.__soundcloudClientPatched
                ) {
                    const originalToggleShuffle = moduleExports.toggleShuffle;
                    let isLoading = false;

                    moduleExports.toggleShuffle = async function() {
                        const shuffleButton = document.querySelector('.shuffleControl');
                        const shuffleAlreadyActive = shuffleButton?.classList.contains('m-shuffling');

                        // Turning shuffle off should remain immediate.
                        if (shuffleAlreadyActive) {
                            return originalToggleShuffle.apply(this, arguments);
                        }

                        if (isLoading) {
                            console.log('[SoundCloud Client] Shuffle queue is already loading');
                            return;
                        }

                        const queue = moduleExports.getQueue();
                        if (!queue) {
                            return originalToggleShuffle.apply(this, arguments);
                        }

                        isLoading = true;

                        if (shuffleButton) {
                            shuffleButton.style.pointerEvents = 'none';
                            shuffleButton.style.opacity = '0.5';
                        }

                        const startedAt = Date.now();
                        let lastLength = queue.length || 0;
                        let stalledCycles = 0;

                        try {
                            console.log(
                                '[SoundCloud Client] Preparing full fair shuffle. Currently loaded:',
                                lastLength
                            );

                            while (
                                moduleExports.hasMoreAhead?.() &&
                                stalledCycles <= MAX_STALLED_CYCLES &&
                                Date.now() - startedAt < MAX_LOAD_TIME_MS
                            ) {
                                try {
                                    moduleExports.pullNext?.(BATCH_SIZE);
                                } catch (error) {
                                    console.error('[SoundCloud Client] Failed to load next shuffle batch:', error);
                                    break;
                                }

                                await new Promise(resolve => setTimeout(resolve, POLL_DELAY_MS));

                                const nextLength = queue.length || getQueueModels(queue)?.length || 0;
                                if (nextLength > lastLength) {
                                    lastLength = nextLength;
                                    stalledCycles = 0;
                                } else {
                                    stalledCycles++;
                                }
                            }

                            if (moduleExports.hasMoreAhead?.()) {
                                console.warn(
                                    '[SoundCloud Client] Queue loading stopped before the absolute end; shuffling everything loaded:',
                                    lastLength
                                );
                            } else {
                                console.log(
                                    '[SoundCloud Client] Full queue loaded:',
                                    lastLength,
                                    'tracks'
                                );
                            }

                            const result = originalToggleShuffle.apply(this, arguments);
                            await Promise.resolve(result);

                            // Let SoundCloud finish its own state transition, then
                            // replace only the upcoming order with our fair round.
                            await new Promise(resolve => setTimeout(resolve, 60));
                            applyFairShuffle(queue);

                            return result;
                        } catch (error) {
                            console.error('[SoundCloud Client] Fair shuffle failed:', error);
                            return originalToggleShuffle.apply(this, arguments);
                        } finally {
                            isLoading = false;

                            if (shuffleButton) {
                                shuffleButton.style.pointerEvents = '';
                                shuffleButton.style.opacity = '';
                            }
                        }
                    };

                    moduleExports.toggleShuffle.__soundcloudClientPatched = true;
                    patchedCount++;
                }
            } catch (_) {
                // SoundCloud bundles contain many unrelated module shapes.
            }
        }

        return patchedCount;
    }

    function patchXHR() {
        if (window.XMLHttpRequest.__soundcloudClientPatched) return;

        const OriginalXHR = window.XMLHttpRequest;

        function PatchedXHR() {
            const xhr = new OriginalXHR();
            const originalOpen = xhr.open;

            xhr.open = function(method, url, ...args) {
                if (typeof url === 'string' && url.includes('api')) {
                    try {
                        const parsed = new URL(url, window.location.origin);

                        if (/\\/(likes|tracks|playlists|favorites|stream)/.test(parsed.pathname)) {
                            const currentLimit = parsed.searchParams.get('limit');

                            if (currentLimit && Number(currentLimit) < MAX_LIMIT) {
                                parsed.searchParams.set('limit', String(MAX_LIMIT));
                                url = parsed.toString();
                            }
                        }
                    } catch (_) {
                        // Leave the request untouched if it is not a normal URL.
                    }
                }

                return originalOpen.call(this, method, url, ...args);
            };

            return xhr;
        }

        Object.setPrototypeOf(PatchedXHR, OriginalXHR);
        PatchedXHR.prototype = OriginalXHR.prototype;
        PatchedXHR.__soundcloudClientPatched = true;
        window.XMLHttpRequest = PatchedXHR;
    }

    const webpackRequire = findWebpackRequire();

    if (webpackRequire) {
        const patched = patchModules(webpackRequire);
        if (patched > 0) {
            console.log('[SoundCloud Client] Full-library fair shuffle enabled');
        }

        let attempts = 0;
        const rescan = setInterval(() => {
            attempts++;
            const newlyPatched = patchModules(webpackRequire);

            if (newlyPatched > 0) {
                console.log('[SoundCloud Client] Patched late-loaded shuffle module');
            }

            if (attempts >= PATCH_RESCAN_ATTEMPTS) {
                clearInterval(rescan);
            }
        }, PATCH_RESCAN_MS);
    } else {
        console.warn('[SoundCloud Client] Could not locate SoundCloud webpack runtime for shuffle fix');
    }

    patchXHR();
})();
`;
