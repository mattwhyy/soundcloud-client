/**
 * Fixes SoundCloud's web player shuffle behavior for large collections.
 *
 * Adapted from iamnotbobby's MIT-licensed shuffle-fix plugin:
 * https://github.com/iamnotbobby/soundcloud-rpc/blob/main/plugins/shuffle-fix.js
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

                        const hasMore = Boolean(moduleExports.hasMoreAhead?.());
                        if (!hasMore) {
                            return originalToggleShuffle.apply(this, arguments);
                        }

                        isLoading = true;

                        if (shuffleButton) {
                            shuffleButton.style.pointerEvents = 'none';
                            shuffleButton.style.opacity = '0.5';
                        }

                        const startedAt = Date.now();
                        let lastLength = queue.length;
                        let stalledCycles = 0;

                        try {
                            console.log(
                                '[SoundCloud Client] Loading full queue before shuffle. Currently loaded:',
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

                                if (queue.length > lastLength) {
                                    lastLength = queue.length;
                                    stalledCycles = 0;
                                } else {
                                    stalledCycles++;
                                }
                            }

                            console.log(
                                '[SoundCloud Client] Shuffle queue ready:',
                                queue.length,
                                'tracks loaded'
                            );

                            return originalToggleShuffle.apply(this, arguments);
                        } catch (error) {
                            console.error('[SoundCloud Client] Shuffle fix failed:', error);
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
                }
            } catch (_) {
                // SoundCloud bundles contain many unrelated module shapes.
            }
        }
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
        patchModules(webpackRequire);
        console.log('[SoundCloud Client] Full-library shuffle fix enabled');
    } else {
        console.warn('[SoundCloud Client] Could not locate SoundCloud webpack runtime for shuffle fix');
    }

    patchXHR();
})();
`;
