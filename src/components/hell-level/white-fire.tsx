'use client'

import { useEffect, useRef } from 'react'

/**
 * White fire for Hell-level's entrance, drawn live on the GPU (WebGL) so it
 * licks, sways and flickers instead of looping: flames carved out of rising,
 * curling turbulence, a smaller white-hot fire inside them, light thrown on
 * the dark around them and smoke off the tips. It kindles over the first
 * seconds; once `leaving` turns true it surges up and burns to white.
 *
 * Without WebGL the canvas hides and whatever is behind it (a soft glow)
 * shows instead. Reduced motion: one still frame.
 */

const VERT = 'attribute vec2 a; void main() { gl_Position = vec4(a, 0.0, 1.0); }'

const FRAG = `
precision highp float;
uniform vec2 uRes;
uniform float uCenter;
uniform float uTime;
uniform float uIntro;
uniform float uSurge;

vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy) * 2.0 - 1.0;
}
float gnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = dot(hash22(i), f);
  float b = dot(hash22(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0));
  float c = dot(hash22(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0));
  float d = dot(hash22(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 5; i++) { v += a * gnoise(p); p = m * p; a *= 0.5; }
  return v;
}

// A flame's outline: a teardrop, 1 at the base centre, 0 at its edge, below 0 outside.
float lobe(vec2 p, float cx, float h, float w) {
  float y = max(p.y, 0.0) / h;
  // Full and round low down, tapering fast towards the tip.
  float halfW = w * (1.0 - 0.86 * pow(clamp(y, 0.0, 1.0), 2.0)) * (0.8 + 0.2 * smoothstep(0.0, 0.25, y));
  float x = (p.x - cx) / halfW;
  return 1.0 - y - x * x * (0.5 + 0.5 * y);
}

// Flames: the outline carved into tongues by rising, curling turbulence.
// Returns how far inside the fire a point is (0 = the edge), and its turbulence.
float carve(vec2 p, float H, float scale, float speed, float seed, float t, out float n) {
  float hy = clamp(p.y / H, 0.0, 1.4);
  // The body snakes: each height is pushed sideways a little, more towards the top.
  float snake = fbm(vec2(p.y * 2.2 - t * speed * 0.55, seed)) * (0.05 + 0.13 * hy) * H;
  vec2 f0 = vec2(p.x - snake, p.y);
  vec2 q = vec2(f0.x * (7.0 + 5.0 * hy) * scale, f0.y * 3.0 * scale - t * speed) + seed;
  vec2 r = vec2(fbm(q * 0.5 + vec2(0.0, t * 0.3)), fbm(q * 0.45 + vec2(5.2, 1.3 - t * 0.2)));
  n = clamp(fbm(q + r * 2.2) * 1.05 + 0.5, 0.0, 1.0);
  float env = lobe(f0, 0.0, H, 0.17);
  env = max(env, lobe(f0, -0.17, H * 0.55, 0.11) * 0.94);
  env = max(env, lobe(f0, 0.175, H * 0.62, 0.11) * 0.94);
  return env + (n - 0.5) * (1.0 + 1.5 * hy) - 0.06;
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  // x centred on the fire, y up from its base; one unit = the canvas height.
  vec2 p = vec2((frag.x - uRes.x * uCenter) / uRes.y, frag.y / uRes.y - 0.02);
  float t = uTime;
  float grow = max(uIntro * (1.0 + uSurge * 1.1), 0.001);
  float H = 0.82 * grow;
  float hy = clamp(p.y / H, 0.0, 1.4);

  // Heat shimmer.
  p += vec2(gnoise(p * 8.0 + vec2(0.0, -t * 3.0)), gnoise(p * 8.0 + vec2(3.1, -t * 2.6))) * 0.003 * smoothstep(0.05, 0.5, hy);

  // The outer flames, translucent; and inside them a smaller, hotter, faster fire.
  float n1, n2;
  float outer = carve(p, H, 1.0, 1.9, 0.0, t, n1);
  float inner = carve(vec2(p.x * 1.6, p.y), H * 0.56, 1.25, 2.5, 23.7, t, n2);

  // Brighter the deeper inside, with streaks of the turbulence running up through it.
  float o = smoothstep(0.0, 0.1, outer) * (0.36 + 0.42 * smoothstep(0.0, 0.7, outer) + 0.38 * pow(n1, 1.5)) * (0.72 + 0.38 * (1.0 - hy));
  float i = smoothstep(-0.04, 0.24, inner) * (0.7 + 0.45 * n2);
  float hot = smoothstep(0.25, 1.0, inner);
  float bloom = smoothstep(-0.3, 0.15, inner) * 0.3;
  float edge = smoothstep(-0.28, 0.02, outer) * (1.0 - smoothstep(0.0, 0.1, outer)) * 0.22;

  // Light thrown into the dark, the ground lit beneath, and smoke off the tips.
  float rg = length(vec2(p.x * 1.2, (p.y - 0.26 * H) * 0.85));
  float glow = exp(-rg * rg * 7.0) * 0.22;
  float floorGlow = exp(-pow(p.x / 0.3, 2.0) - pow((p.y + 0.02) / 0.04, 2.0)) * 0.35;
  float smoke = fbm(vec2(p.x * 2.6, p.y * 1.7 - t * 0.5) + 9.0) * 0.5 + 0.5;
  smoke = smoothstep(0.5, 0.85, smoke) * smoothstep(0.55, 1.0, hy) * smoothstep(1.4, 0.95, hy) * exp(-p.x * p.x * 14.0) * 0.1;

  float flicker = 0.93 + 0.07 * gnoise(vec2(t * 2.3, 0.5));
  float v = (o + i * 0.9 + hot * 1.2 + bloom + edge) * flicker + glow + floorGlow + smoke;
  v *= min(uIntro * 1.4, 1.0);
  v += uSurge * uSurge * smoothstep(1.0, 0.0, rg) * 3.0;

  float c = 1.0 - exp(-v * 1.5);
  // Dither, so the dark gradients don't band.
  c += (fract(sin(dot(frag, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;
  gl_FragColor = vec4(vec3(c), 1.0);
}
`

/** When the fire starts to kindle, and how long until it's fully up (seconds). */
const KINDLE_AT = 0.2
const KINDLE_FOR = 2.4
/** How long the surge takes once leaving (ms). */
const SURGE_MS = 750

export function WhiteFire({ leaving, className }: { leaving: React.RefObject<boolean>; className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const el = canvas.current
    const gl = el?.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false })
    if (!el || !gl) {
      if (el) el.style.display = 'none'
      return
    }
    const shader = (type: number, src: string) => {
      const sh = gl.createShader(type)!
      gl.shaderSource(sh, src)
      gl.compileShader(sh)
      return sh
    }
    const prog = gl.createProgram()!
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERT))
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FRAG))
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.warn('[hell-level] the fire shader did not build:', gl.getProgramInfoLog(prog))
      el.style.display = 'none'
      return
    }
    gl.useProgram(prog)
    // One triangle over the whole canvas.
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    const a = gl.getAttribLocation(prog, 'a')
    gl.enableVertexAttribArray(a)
    gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0)
    const u = (name: string) => gl.getUniformLocation(prog, name)
    const uRes = u('uRes')
    const uCenter = u('uCenter')
    const uTime = u('uTime')
    const uIntro = u('uIntro')
    const uSurge = u('uSurge')

    // Fire is soft: drawn at a fraction of the screen's pixels and scaled up, it looks the same and costs far less.
    const size = () => {
      const w = el.clientWidth
      const h = el.clientHeight
      const scale = w * h > 1_200_000 ? 0.5 : 0.62
      el.width = Math.max(1, Math.round(w * scale))
      el.height = Math.max(1, Math.round(h * scale))
      gl.viewport(0, 0, el.width, el.height)
    }
    size()

    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const start = performance.now()
    let leftAt = 0
    let raf = 0
    const draw = (now: number) => {
      const t = (now - start) / 1000
      const k = still ? 1 : Math.min(1, Math.max(0, (t - KINDLE_AT) / KINDLE_FOR))
      if (leaving.current && !leftAt) leftAt = now
      gl.uniform2f(uRes, el.width, el.height)
      // Centred in its canvas on a phone (the fire sits above the title), right of centre beside the copy.
      gl.uniform1f(uCenter, window.innerWidth <= 820 ? 0.5 : 0.56)
      gl.uniform1f(uTime, (still ? 8 : t) + 10)
      gl.uniform1f(uIntro, 1 - Math.pow(1 - k, 3))
      gl.uniform1f(uSurge, leftAt ? Math.min(1, (now - leftAt) / SURGE_MS) : 0)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      // Reduced motion: one still frame (redrawn on resize).
      if (!still) raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    const watch = new ResizeObserver(() => {
      size()
      if (still) draw(performance.now())
    })
    watch.observe(el)

    return () => {
      cancelAnimationFrame(raf)
      watch.disconnect()
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
  }, [leaving])

  return <canvas ref={canvas} className={className} aria-hidden />
}
