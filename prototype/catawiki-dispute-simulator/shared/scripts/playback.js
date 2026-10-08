// One clock and control policy for every teaching scenario.
export const PACKET_DURATION = 1800;
export function createPlayback() {
  const speedInput = document.querySelector('#speed-control,#speed');
  const pauseButton = document.querySelector('#pause-button,#pause');
  const output = document.querySelector('#speed-output');
  const animations = new Map();
  const listeners = new Set();
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let speed = Number(speedInput.value);
  let manuallyPaused = false;
  let paused = document.hidden;
  speedInput.min = '0.5'; speedInput.max = '1.5'; speedInput.step = '0.05';
  function sync() {
    paused = manuallyPaused || document.hidden;
    document.body.classList.toggle('simulation-paused', paused);
    pauseButton.textContent = paused ? '▶ Resume' : 'Ⅱ Pause';
    pauseButton.setAttribute('aria-pressed', String(paused));
    const label = speed.toFixed(2).replace(/0$/, '') + '×';
    output.textContent = label; output.value = label;
    speedInput.setAttribute('aria-valuetext', speed + ' times speed');
    for (const [animation, rate] of animations) {
      animation[rate] = speed;
      paused ? animation.pause() : animation.play();
    }
    for (const listener of listeners) listener({paused, speed});
  }
  pauseButton.addEventListener('click', () => { manuallyPaused = !manuallyPaused; sync(); });
  speedInput.addEventListener('input', () => { speed = Number(speedInput.value); sync(); });
  document.addEventListener('visibilitychange', sync);
  sync();
  function track(animation, rate = 'speed') {
    animations.set(animation, rate);
    animation[rate] = speed;
    if (paused) animation.pause();
    const release = () => animations.delete(animation);
    animation.finished.then(release, release);
    return release;
  }
  function wait(milliseconds, {signal, progress = () => {}, shouldStop = () => false} = {}) {
    const total = reducedMotion ? Math.min(milliseconds, 120) : milliseconds;
    return new Promise((resolve, reject) => {
      let elapsed = 0, previous = performance.now(), frame;
      const abort = () => { cancelAnimationFrame(frame); signal?.removeEventListener('abort', abort); reject(new DOMException('Scene changed', 'AbortError')); };
      const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
      if (signal?.aborted) return abort();
      signal?.addEventListener('abort', abort, {once:true});
      progress(0);
      const tick = now => {
        if (shouldStop()) return finish();
        if (!paused) elapsed += Math.min(now - previous, 100) * speed;
        previous = now;
        progress(total > 0 ? Math.min(1, elapsed / total) : 1);
        if (elapsed >= total) finish(); else frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    });
  }
  return {
    get paused() {return paused;}, get speed() {return speed;},
    duration(milliseconds) {return reducedMotion ? Math.min(milliseconds, 120) : milliseconds;},
    track, wait,
    subscribe(listener) {listeners.add(listener); listener({paused,speed}); return () => listeners.delete(listener);},
  };
}
