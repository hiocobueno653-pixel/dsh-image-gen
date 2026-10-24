/** dsh-image-gen 浏览器半（手写 __ModuleLoader__ 工厂，无构建链，无 JSX）。
 *
 *  形态：**生图不是消息，是这一轮的结果卡片**。
 *    · 生成中：`tool.call.toolview`（key = `generate_image`）在工具行里播 GridReveal 动画
 *    · 出图后：工具行整行收掉，图片出现在**该轮的 Turn 尾卡片**上
 *      （`conversation.chat.turnTail` 席位，渲染在收尾文案下方、过程组之外）
 *
 *  为什么图片不能待在工具行里（这是"有时看不见"的根因，别改回去）：
 *    宿主 ChatGroupSeat 对工具调用有两层折叠——
 *      grouped   = stepGrouping === 'collapsed' || (stepGrouping === 'history' && turn.status !== 'open')
 *      outerHidden = foldCompleted && turnClosed && stored.answerStep !== spec.answerStep
 *    默认档位（standard）两者都是 true：回合一旦结束，整个过程组连同里面的图片被 `hidden`。
 *    靠 CSS 覆盖 content-visibility 是对抗宿主的折叠，React 每次重建都要重新打；
 *    Turn 尾卡片是宿主自己声明"渲染在过程组之外"的位置，不需要对抗任何东西。
 *    这条路子是官方范例：ui-schedule 的 schedule_create 卡片同样用
 *    `ctx.uiConversation.events.register(Definition)` + `conversation.chat.turnTail` 席位，
 *    把结果发布到 Turn 上，靠会话日志重放重建——刷新页面后图片照样在。
 *
 *  动画：GridReveal —— rareui 的格子编排 + bencho.dev/blocks/generate 的"显影"节奏。
 *    canvas 上 180 个格子由 1 个根格二分分裂而来，按 progress 依次裂开、缝隙先开后合、从图片取平均色着色。
 *    图片没到时进度停在 WAIT_CAP(0.72)；图片一到，进入"显影"：照片先在玻璃下以
 *    大块模糊形状出现（blur 17→0、contrast 2.1→1、轻微收拢、液体扰动逐渐静置），
 *    格子马赛克（已染上照片自己的分块色）在上面继续细分并最后溶解——先定大的，后定细的。
 *    只有"刚刚出图"（12s 内）才播，刷新后重放的历史图直接显示。
 *  数据：图片走 durable 附件（`loadImage`，经 callId → loader 记录传给 Turn 尾卡片），
 *    退回同源路由 `/image-gen/raw/<callId>/<n>`（服务端按 callId 从磁盘读，刷新/跨天都有效）。
 */
window.__ModuleLoader__.load({
	id: "dsh-image-gen",
	factory: function (require) {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var React = require("react");
		var h = React.createElement;
		var useState = React.useState;
		var useEffect = React.useEffect;
		var useRef = React.useRef;

		var NS = "image-gen";
		var SERVICE = "imageGen";
		var TOOL = "generate_image";

		/* ==================================================================
		 *  GridReveal —— rareui.com/components/gridreveal 的格子编排
		 *  + bencho.dev/blocks/generate 的"显影"节奏（先定大的、后定细的）。
		 *
		 *  Bencho 的做法：图一直在玻璃下，一个时钟开三个窗口——
		 *    shapes = smooth(0.1, 0.82, t)   模糊 20→1.6px、对比 2.4→1
		 *    grain  = smooth(0.7, 1, t)      颗粒/细节最后才定
		 *    ripple ∝ (1-t)^1.5              液体逐渐静置
		 *    scale  1.04→1                   轻微收拢
		 *  移植到 canvas：照片落地后立刻以"大块模糊形状"在底层显影，
		 *  格子马赛克（已染上照片自己的分块平均色）在上面继续细分，
		 *  最后随照片锐化一起溶解——大块先定，细节后定。
		 * ================================================================== */
		var CELLS = 180;
		var OPENING_CELLS = 4;
		var HOLD = 0.9;          // 永远差一点到 1，图片没落地就跑不满
		var WAIT_CAP = 0.72;     // 等待时格子最多裂到这里，给"到达"留出余地
		var LAST_SPLIT = 0.92;
		var MORPH = 0.055;       // 单个格子裂开占多少进度
		var SAMPLE = 128;
		var GUTTER_FROM = 0.35;
		var GUTTER_TO = 0.75;
		/* —— 显影（bencho）参数 —— */
		var DEV_MS = 1700;       // 从落地到完全清晰的时间窗
		var BLUR_FROM = 17;      // 起始模糊（相对 360px 短边）
		var CONTRAST_FROM = 2.1; // 起始对比（大块形状更"糊成一团"）
		var SHAPE_FROM = 0.08;   // 形状窗口
		var SHAPE_TO = 0.9;
		var GRAIN_FROM = 0.25;   // 马赛克从这开始溶解（细节后定，但要给显影留出可见窗口）
		var SCALE_FROM = 1.045;  // 轻微收拢
		var TINT_FROM = 0;       // 格子染上照片色的窗口
		var TINT_TO = 0.28;
		var RIPPLE_SLICES = 26;  // 液体扰动的切片数
		var RIPPLE_AMP = 0.022;  // 相对高度的最大偏移

		function clamp01(n) {
			return n > 0 ? (n < 1 ? n : 1) : 0;
		}
		function mix(a, b, t) {
			return a + (b - a) * t;
		}
		function easeOut(t) {
			return 1 - Math.pow(1 - t, 3);
		}
		function smoothstep(a, b, x) {
			var t = clamp01((x - a) / (b - a));
			return t * t * (3 - 2 * t);
		}
		function selfPaced(elapsed, duration) {
			var span = duration > 0 ? duration : 1;
			return HOLD * (1 - Math.exp(-elapsed / span));
		}
		function hash(x, y, z) {
			var n = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
			return n - Math.floor(n);
		}
		function makeCell(x, y, w, hgh, parent) {
			return {
				x: x,
				y: y,
				w: w,
				h: hgh,
				r: 0,
				g: 0,
				b: 0,
				tone: hash(x + 3.1, y + 1.7, w * 31.7),
				detail: 0,
				splitAt: 0,
				parent: parent,
				kids: null,
			};
		}
		/** 每次裂开最大的那格 → 格子保持方正、数量一格格涨。 */
		function buildTree(aspect) {
			var root = makeCell(0, 0, 1, 1, null);
			var leaves = [root];
			var branches = [];
			while (leaves.length < CELLS) {
				var pick = 0;
				var widest = -1;
				for (var i = 0; i < leaves.length; i++) {
					var c = leaves[i];
					var area = c.w * aspect * c.h * (1 + 0.12 * hash(c.x, c.y, 7.3));
					if (area > widest) {
						widest = area;
						pick = i;
					}
				}
				var parent = leaves.splice(pick, 1)[0];
				var wide = parent.w * aspect >= parent.h;
				var half = wide ? parent.w / 2 : parent.h / 2;
				var a = wide ? makeCell(parent.x, parent.y, half, parent.h, parent) : makeCell(parent.x, parent.y, parent.w, half, parent);
				var b = wide ? makeCell(parent.x + half, parent.y, half, parent.h, parent) : makeCell(parent.x, parent.y + half, parent.w, half, parent);
				parent.kids = [a, b];
				branches.push(parent);
				leaves.push(a, b);
			}
			var opening = OPENING_CELLS - 1;
			var rest = Math.max(1, branches.length - opening);
			branches.forEach(function (cell, i) {
				// 开头几刀的 splitAt 放在 0 之前 → 第一帧它们就已经分开了
				cell.splitAt = i < opening ? -MORPH : (LAST_SPLIT * (i - opening + 1)) / rest;
			});
			return { root: root, branches: branches };
		}
		/** 每格平均色 + 亮度方差（方差决定谁先裂）。 */
		function measureTree(root, pixels, size) {
			function gather(cell) {
				var s;
				if (cell.kids) {
					var a = gather(cell.kids[0]);
					var b = gather(cell.kids[1]);
					s = { n: a.n + b.n, r: a.r + b.r, g: a.g + b.g, b: a.b + b.b, l: a.l + b.l, l2: a.l2 + b.l2 };
				} else {
					s = { n: 0, r: 0, g: 0, b: 0, l: 0, l2: 0 };
					var x0 = Math.round(cell.x * size);
					var y0 = Math.round(cell.y * size);
					var x1 = Math.max(x0 + 1, Math.round((cell.x + cell.w) * size));
					var y1 = Math.max(y0 + 1, Math.round((cell.y + cell.h) * size));
					for (var y = y0; y < y1; y++) {
						for (var x = x0; x < x1; x++) {
							var i = (y * size + x) * 4;
							var r = pixels[i];
							var g = pixels[i + 1];
							var bl = pixels[i + 2];
							var l = 0.299 * r + 0.587 * g + 0.114 * bl;
							s.n++;
							s.r += r;
							s.g += g;
							s.b += bl;
							s.l += l;
							s.l2 += l * l;
						}
					}
				}
				var n = s.n || 1;
				cell.r = s.r / n;
				cell.g = s.g / n;
				cell.b = s.b / n;
				cell.detail = Math.max(0, s.l2 / n - (s.l / n) * (s.l / n));
				return s;
			}
			gather(root);
		}
		/** 只换顺序不换节奏：把细节最多的格子放进最早的时间槽。 */
		function orderByDetail(branches, openedBefore) {
			var pending = branches.filter(function (c) {
				return c.splitAt > openedBefore;
			});
			if (pending.length < 2) return;
			var slots = pending
				.map(function (c) {
					return c.splitAt;
				})
				.sort(function (a, b) {
					return a - b;
				});
			var queue = pending.filter(function (c) {
				return !c.parent || c.parent.splitAt <= openedBefore;
			});
			var next = 0;
			while (queue.length && next < slots.length) {
				var pick = 0;
				for (var i = 1; i < queue.length; i++) if (queue[i].detail > queue[pick].detail) pick = i;
				var cell = queue.splice(pick, 1)[0];
				cell.splitAt = slots[next++];
				(cell.kids || []).forEach(function (kid) {
					if (kid.kids) queue.push(kid);
				});
			}
		}
		function coverRect(iw, ih, w, hgh) {
			var s = Math.max(w / iw, hgh / ih);
			return { dx: (w - iw * s) / 2, dy: (hgh - ih * s) / 2, dw: iw * s, dh: ih * s };
		}
		function greyOf(tone, dark, clock) {
			return (dark ? 30 : 228) + tone * 13 + Math.sin(clock * 1.5 + tone * 6.28) * 3;
		}
		/* 显影缓冲：照片先画进离屏（模糊+对比+轻微收拢），再切片贴回主画布做液体扰动。
		   每帧只画一次，切片复用同一张位图，成本远低于逐切片重跑滤镜。 */
		var devBuf = null;
		function developLayer(s, shapes) {
			var w = s.width;
			var h = s.height;
			if (!devBuf) devBuf = document.createElement("canvas");
			if (devBuf.width !== w || devBuf.height !== h) {
				devBuf.width = w;
				devBuf.height = h;
			}
			var b = devBuf.getContext("2d");
			b.clearRect(0, 0, w, h);
			b.save();
			/* bencho：blur 20→1.6px、contrast 2.4→1、scale 1.04→1 —— 大形状先定，边缘后定 */
			var unit = Math.min(w, h) / 360;
			var blur = mix(BLUR_FROM, 0, shapes) * unit;
			var contrast = mix(CONTRAST_FROM, 1, shapes);
			if (typeof b.filter === "string") {
				b.filter = "blur(" + blur.toFixed(2) + "px) contrast(" + contrast.toFixed(3) + ")";
			}
			var scale = mix(SCALE_FROM, 1, smoothstep(0, 0.9, s.dev));
			var dw = w * scale;
			var dh = h * scale;
			var fit = coverRect(s.image.naturalWidth, s.image.naturalHeight, dw, dh);
			b.drawImage(s.image, fit.dx + (w - dw) / 2, fit.dy + (h - dh) / 2, fit.dw, fit.dh);
			b.restore();
			return devBuf;
		}
		function drawScene(s) {
			var ctx = s.ctx;
			var root = s.root;
			var width = s.width;
			var height = s.height;
			var split = s.split;
			var dev = s.dev;
			var tint = s.hasColors ? smoothstep(TINT_FROM, TINT_TO, dev) : 0;   // 拿不到像素就保持灰格
			var shade = function (grey, target) {
				return Math.round(mix(grey, target, tint));
			};
			var base = greyOf(root.tone, s.dark, s.clock);

			// 缝隙陷进这个底色，而不是直接透到后面的页面
			ctx.fillStyle =
				"rgb(" + Math.round(shade(base, root.r) * 0.92) + "," + Math.round(shade(base, root.g) * 0.92) + "," + Math.round(shade(base, root.b) * 0.92) + ")";
			ctx.fillRect(0, 0, width, height);

			/* —— 底层：照片在玻璃下显影（bencho 的"先定大的"）—— */
			if (s.image && dev > 0) {
				var shapes = smoothstep(SHAPE_FROM, SHAPE_TO, dev);
				var photo = smoothstep(0, 0.3, dev) * mix(0.72, 1, shapes);
				var buf = developLayer(s, shapes);
				if (buf && photo > 0.002) {
					ctx.save();
					ctx.globalAlpha = photo;
					/* 液体扰动 ∝ (1-t)^1.5：逐渐静置 */
					var amp = RIPPLE_AMP * height * Math.pow(1 - dev, 1.5);
					var slices = amp > 0.6 ? RIPPLE_SLICES : 1;
					var sh = height / slices;
					for (var i = 0; i < slices; i++) {
						var off = slices > 1 ? Math.sin(s.clock * 2.2 + i * 0.8) * amp : 0;
						ctx.drawImage(buf, 0, i * sh, width, sh, off, i * sh, width, sh);
					}
					ctx.restore();
				}
			}

			/* —— 上层：格子马赛克继续细分，最后整体溶解（bencho 的"细节后定"）—— */
			var grain = 1 - smoothstep(GRAIN_FROM, 1, dev);
			if (grain > 0.002) {
				var soft = 1 - smoothstep(GUTTER_FROM, GUTTER_TO, split);
				var gutter = s.scale * soft;
				var rounded = soft > 0.01 && typeof ctx.roundRect === "function";

				function paint(p) {
					// 对齐整像素，相邻格子严丝合缝
					var x = Math.round(p.x);
					var y = Math.round(p.y);
					var w = Math.round(p.x + p.w) - x;
					var hh = Math.round(p.y + p.h) - y;
					var onLeft = x <= 0;
					var onTop = y <= 0;
					var onRight = x + w >= width;
					var onBottom = y + hh >= height;
					// 只给内部边留缝，外轮廓保持整框
					var left = onLeft ? 0 : gutter;
					var top = onTop ? 0 : gutter;
					var innerW = w - left - (onRight ? 0 : gutter);
					var innerH = hh - top - (onBottom ? 0 : gutter);
					if (innerW <= 0 || innerH <= 0) return;
					var grey = greyOf(p.tone, s.dark, s.clock);
					ctx.fillStyle = "rgb(" + shade(grey, p.r) + "," + shade(grey, p.g) + "," + shade(grey, p.b) + ")";
					if (rounded) {
						var radius = Math.min(innerW, innerH) * 0.12 * soft;
						ctx.beginPath();
						ctx.roundRect(x + left, y + top, innerW, innerH, [
							!onLeft && !onTop ? radius : 0,
							!onRight && !onTop ? radius : 0,
							!onRight && !onBottom ? radius : 0,
							!onLeft && !onBottom ? radius : 0,
						]);
						ctx.fill();
					} else {
						ctx.fillRect(x + left, y + top, innerW, innerH);
					}
				}

				function walk(cell, p) {
					if (!cell.kids || split < cell.splitAt) {
						paint(p);
						return;
					}
					// 子格从父格矩形出发，再分离到自己的位置
					var t = easeOut(clamp01((split - cell.splitAt) / MORPH));
					cell.kids.forEach(function (kid) {
						walk(kid, {
							x: mix(p.x, kid.x * width, t),
							y: mix(p.y, kid.y * height, t),
							w: mix(p.w, kid.w * width, t),
							h: mix(p.h, kid.h * height, t),
							r: mix(p.r, kid.r, t),
							g: mix(p.g, kid.g, t),
							b: mix(p.b, kid.b, t),
							tone: mix(p.tone, kid.tone, t),
						});
					});
				}

				ctx.save();
				ctx.globalAlpha = grain;
				walk(root, { x: 0, y: 0, w: width, h: height, r: root.r, g: root.g, b: root.b, tone: root.tone });
				ctx.restore();
			}
		}
		function readAverages(el, root, branches, at) {
			var buffer = document.createElement("canvas");
			buffer.width = SAMPLE;
			buffer.height = SAMPLE;
			var ctx = buffer.getContext("2d", { willReadFrequently: true });
			if (!ctx) return false;
			var fit = coverRect(el.naturalWidth, el.naturalHeight, SAMPLE, SAMPLE);
			ctx.drawImage(el, fit.dx, fit.dy, fit.dw, fit.dh);
			try {
				measureTree(root, ctx.getImageData(0, 0, SAMPLE, SAMPLE).data, SAMPLE);
				orderByDetail(branches, at);
				return true;
			} catch (e) {
				return false;   // 跨域被污染等：退回灰格
			}
		}
		/** 主题明暗：读 DSH 的 --dsw-alias-bg-base 亮度，取不到就退回系统偏好。 */
		var darkCache = { at: 0, value: false };
		function detectDark() {
			var now = Date.now();
			if (now - darkCache.at < 500) return darkCache.value;
			darkCache.at = now;
			var value = null;
			try {
				var raw = getComputedStyle(document.documentElement).getPropertyValue("--dsw-alias-bg-base").trim();
				var m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(raw);
				if (m) value = 0.299 * Number(m[1]) + 0.587 * Number(m[2]) + 0.114 * Number(m[3]) < 128;
				else if (document.documentElement.classList.contains("dark")) value = true;
			} catch (e) {
				value = null;
			}
			if (value === null) value = typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
			darkCache.value = value;
			return value;
		}
		function useReducedMotion() {
			var _r = useState(function () {
				try {
					return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
				} catch (e) {
					return false;
				}
			});
			var reduce = _r[0];
			var setReduce = _r[1];
			useEffect(
				function () {
					if (typeof matchMedia !== "function") return function () {};
					var mq = matchMedia("(prefers-reduced-motion: reduce)");
					var onChange = function () {
						setReduce(mq.matches);
					};
					if (mq.addEventListener) mq.addEventListener("change", onChange);
					else if (mq.addListener) mq.addListener(onChange);
					return function () {
						if (mq.removeEventListener) mq.removeEventListener("change", onChange);
						else if (mq.removeListener) mq.removeListener(onChange);
					};
				},
				[],
			);
			return reduce;
		}

		/**
		 * src 为 null 时只是"等待中的格子墙"；src 一到（图片加载完）就以图片落地收尾整段动画。
		 * progress 省略 = 自走模式（estimatedDuration 为时间常数）。
		 */
		function GridReveal(props) {
			var src = props.src || null;
			var alt = props.alt || "";
			var aspect = props.aspect;
			var caption = props.caption || "";
			var estimatedDuration = props.estimatedDuration || 12000;
			var reduce = useReducedMotion();
			var ratio = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;

			var frameRef = useRef(null);
			var canvasRef = useRef(null);
			var _loaded = useState(false);
			var loaded = _loaded[0];
			var setLoaded = _loaded[1];
			var _revealed = useState(false);
			var revealed = _revealed[0];
			var setRevealed = _revealed[1];
			var _lastSrc = useState(src);
			var lastSrc = _lastSrc[0];
			var setLastSrc = _lastSrc[1];

			if (src !== lastSrc) {
				setLastSrc(src);
				setRevealed(false);
			}

			var durationRef = useRef(estimatedDuration);
			var doneRef = useRef(props.onRevealComplete);
			var errorRef = useRef(props.onError);
			// src/ratio 走 ref：宿主高频重渲染时不打断动画循环（循环只挂载一次）
			var srcRef = useRef(src);
			var ratioRef = useRef(ratio);
			var startedRef = useRef(false);
			useEffect(function () {
				durationRef.current = estimatedDuration;
				doneRef.current = props.onRevealComplete;
				errorRef.current = props.onError;
				srcRef.current = src;
				ratioRef.current = ratio;
			});

			useEffect(
				function () {
					var canvas = canvasRef.current;
					var frame = frameRef.current;
					if (!canvas || !frame) return;
					var ctx = canvas.getContext("2d");
					if (!ctx) return;

					var tree = buildTree(ratioRef.current);
					var root = tree.root;
					var branches = tree.branches;
					var loadedUrl = null;
					var scene = {
						ctx: ctx,
						root: root,
						width: 0,
						height: 0,
						scale: 1,
						dark: false,
						clock: 0,
	split: 0,
						dev: 0,        // 显影进度（照片落地后 0→1）
						hasColors: false,
						image: null,
					};
					var loadedAt = -1;
					var cancelled = false;

					function render(split, now) {
						scene.dark = detectDark();
						scene.split = split;
						scene.dev = loadedAt < 0 ? 0 : clamp01((now - loadedAt) / DEV_MS);
						drawScene(scene);
					}
					function repaint() {
						if (!reduce) return render(scene.split, performance.now());
						var settled = loadedAt < 0 ? performance.now() : loadedAt + DEV_MS;
						render(scene.image ? 1 : WAIT_CAP, settled);
					}
					function resize() {
						var dpr = Math.min(window.devicePixelRatio || 1, 2);
						var rect = frame.getBoundingClientRect();
						var w = Math.max(1, Math.round(rect.width * dpr));
						var hh = Math.max(1, Math.round(rect.height * dpr));
						scene.scale = dpr;
						if (w === scene.width && hh === scene.height) return;
						scene.width = w;
						scene.height = hh;
						canvas.width = w;
						canvas.height = hh;
						repaint();   // 改 canvas 尺寸会清空画布，必须重画
					}

					resize();
					var observer = typeof ResizeObserver === "function" ? new ResizeObserver(resize) : null;
					if (observer) observer.observe(frame);

					function load(url, withCors) {
						var el = new Image();
						if (withCors) el.crossOrigin = "anonymous";
						el.decoding = "async";
						el.onload = function () {
							if (cancelled) return;
							if (!el.naturalWidth || !el.naturalHeight) {
								if (errorRef.current) errorRef.current();
								return;
							}
							scene.image = el;
							loadedAt = performance.now();
							scene.hasColors = readAverages(el, root, branches, scene.split);
							setLoaded(true);
							/* reduce 模式只补一帧静态图：不能再把动画循环拉起来，
							   否则"减少动态效果"的用户照样会被播一遍显影 + 格子溶解。 */
							if (reduce) {
								repaint();
							} else {
								// 图片到达即重启动画循环：无论之前是被可见性停掉、被 cleanup 取消，
								// 还是宿主高频重渲染打断了帧——出图这一刻必须把图画出来
								stopped = false;
								start();
							}
						};
						el.onerror = function () {
							if (cancelled) return;
							// 对方不回 CORS 头就退回普通请求
							if (withCors) load(url, false);
							else if (errorRef.current) errorRef.current();
							if (reduce) repaint();
							else {
								stopped = false;
								start();
							}
						};
						el.src = url;
					}
					if (srcRef.current) { loadedUrl = srcRef.current; load(srcRef.current, true); }

					if (reduce) {
						repaint();
						return function () {
							cancelled = true;
							if (observer) observer.disconnect();
						};
					}

					var frameId = 0;
					var last = 0;
					var elapsed = 0;
					var eased = 0;
					var split = 0;
					var fired = false;
					var stopped = false;
					var visible = true;

					function tick(now) {
						frameId = requestAnimationFrame(tick);
						if (!last) last = now;
						var dt = Math.min((now - last) / 1000, 0.05);
						last = now;
						elapsed += dt;
						scene.clock = elapsed;

						var cur = srcRef.current;
						if (cur !== loadedUrl) {   // src 变化（null→URL 或换源）：热加载，不动循环
							loadedUrl = cur || null;
							if (cur) load(cur, true); else { scene.image = null; loadedAt = -1; }
						}
						var ready = scene.image !== null;
						var target = ready ? 1 : selfPaced(elapsed * 1000, durationRef.current);
						eased += (target - eased) * (1 - Math.exp(-dt * 5.5));
						var wanted = Math.min(eased, ready ? 1 : WAIT_CAP);
						split += (wanted - split) * (1 - Math.exp(-dt * 4));
						render(split, now);

						if (!fired && ready && eased > 0.995 && now - loadedAt > DEV_MS) {
							fired = true;
							setRevealed(true);
							if (doneRef.current) doneRef.current();
						}
						if (fired && split > 0.9995) {
							render(1, now);
							stopped = true;
							cancelAnimationFrame(frameId);   // 之后没有动静了，不再烧帧
						}
					}
					function start() {
						if (stopped) return;
						last = 0;
						cancelAnimationFrame(frameId);
						frameId = requestAnimationFrame(tick);
					}
					var visibility =
						typeof IntersectionObserver === "function"
							? new IntersectionObserver(
									function (entries) {
										var entry = entries[0];
										if (entry.isIntersecting === visible) return;
										visible = entry.isIntersecting;
										if (visible) start();
										else cancelAnimationFrame(frameId);
									},
									{ rootMargin: "150px" },
								)
							: null;
					if (visibility) visibility.observe(frame);
					start();

					return function () {
						cancelled = true;
						cancelAnimationFrame(frameId);
						if (observer) observer.disconnect();
						if (visibility) visibility.disconnect();
					};
				},
				[reduce],
			);

			useEffect(
				function () {
					if (reduce && loaded && doneRef.current) doneRef.current();
				},
				[reduce, loaded],
			);

			var finished = reduce ? loaded : revealed;
			/* fill：父级（.ig-frameLink）已经用同一个 boxStyle 定好盒子，这里只管填满；
			   否则自己按 aspect 定形（工具行里等待动画的用法）。 */
			var fill = !!props.fill;
			return h(
				"div",
				{
					ref: frameRef,
					className: "ig-frame",
					// 与成图共用 boxStyle()：同一个像素盒子，落地时不跳。
					style: fill ? { width: "100%", height: "100%" } : boxStyle(ratio),
					"data-slot": "grid-reveal",
				},
				h("canvas", {
					ref: canvasRef,
					className: "ig-canvas",
					role: alt ? "img" : undefined,
					"aria-label": alt || undefined,
					"aria-hidden": alt ? undefined : "true",
				}),
				caption
					? h(
							"div",
							{ className: "ig-caption" + (finished ? " ig-captionDone" : "") },
							h("span", { className: "ig-captionText" }, caption),
						)
					: null,
			);
		}

		/* ==================================================================
		 *  Remote contribution / 样式 / 工具卡
		 * ================================================================== */
		var passthrough = {
			parse: function (v) {
				return v === undefined ? {} : v;
			},
		};
		function codec(sym) {
			return {
				mode: "strict",
				typeSymbol: "dsh-image-gen#" + sym,
				schema: passthrough,
				create: function () {
					return passthrough;
				},
			};
		}
		function descriptor(method) {
			return {
				id: NS + "#" + SERVICE + "/" + method,
				service: SERVICE,
				namespace: SERVICE,
				method: method,
				invocation: { kind: "direct" },
				parameters: [{ name: "query", wire: "query", source: "json", acceptsUndefined: true, codec: codec(method + ":query") }],
				result: codec(method + ":result"),
				sourceLocation: { file: "src/cordis.js", line: 1, column: 1 },
			};
		}
		var CONTRIBUTION = {
			package: "dsh-image-gen",
			descriptors: [descriptor("progress"), descriptor("result"), descriptor("recent"), descriptor("modelsAdmin")],
		};

		/* 设置页导航「图像模型」那一行的图标。
		 * 宿主 navIcon(id) 是写死的 id→图标映射（account/models/plugins/…），不在表里的
		 * id 一律给齿轮；而 settings.section 的注册契约只有 id/order/label，没有 icon。
		 * 所以**不碰宿主的 DOM 结构**：只给那一行打个属性，图标交给 CSS 的 mask 画
		 * （宿主自己的 svg 留在树里只是不显示，React 下次更新不会拿着被替换的节点报错）。
		 * ⚠️ 这段必须在 `var CSS` 之前：CSS 数组是模块加载时求值的字符串拼接。 */
		var NAV_LABEL = "图像模型";
		/* lucide "images"，24×24 stroke。mask 取 alpha，所以描边画成不透明黑。 */
		var NAV_ICON_SVG =
			"<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'>" +
			"<path d='m22 11-1.296-1.296a2.4 2.4 0 0 0-3.408 0L11 16'/><path d='M4 8a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2'/>" +
			"<circle cx='13' cy='7' r='1' fill='black'/><rect x='8' y='2' width='14' height='14' rx='2'/></svg>";
		function navIconMask() {
			var encoded = String(NAV_ICON_SVG).replace(/</g, "%3C").replace(/>/g, "%3E").replace(/\s+/g, " ");
			return "url(\"data:image/svg+xml," + encoded + "\")";
		}
		var CSS = [
			/* 出图后就是一张**正常尺寸的图片**：宽 = min(列宽, 72vh×比例)（内联样式给出），
			   横图竖图都完整落在一屏内、比例不变形——与生成中的动画占位框完全同尺寸。 */
			".ig-root{display:contents}",
			".ig-item{width:100%;max-width:320px;box-sizing:border-box}",
			/* 图片填满盒子（比例由盒子的 aspect-ratio 决定，不依赖图片原始像素比）——
			   这样成图与生成中的动画框是同一个像素盒子，落地时不跳也不变形。 */
			".ig-image{display:block;width:100%;height:100%;object-fit:cover;border-radius:12px;cursor:zoom-in;background:var(--dsw-alias-bg-layer-2)}",
			/* GridReveal 框（生成中占位）：尺寸由内联 style 控制（与成图一致） */
			".ig-frame{position:relative;overflow:hidden;border-radius:12px;background:var(--dsw-alias-bg-layer-2)}",
			".ig-canvas{display:block;width:100%;height:100%}",
			/* 底部胶囊标注（原组件用 motion 做的闪烁文字；插件运行期不传 caption） */
			".ig-caption{pointer-events:none;position:absolute;left:12px;bottom:12px;display:flex;align-items:center;height:24px;padding:0 10px;border-radius:9999px;background:rgba(0,0,0,.45);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);transition:opacity .28s cubic-bezier(.4,0,.2,1)}",
			".ig-captionDone{opacity:0}",
			".ig-captionText{display:block;white-space:nowrap;font-size:11px;font-weight:500;line-height:24px;background-image:linear-gradient(90deg,rgba(255,255,255,.5) 40%,rgba(255,255,255,.98) 50%,rgba(255,255,255,.5) 60%);background-size:250% 100%;background-position:105% 0%;-webkit-background-clip:text;background-clip:text;color:transparent;animation:ig-shimmer 2.1s cubic-bezier(.45,0,.55,1) infinite}",
			"@keyframes ig-shimmer{0%{background-position:105% 0%}76%{background-position:-5% 0%}100%{background-position:-5% 0%}}",
			/* 出图后整张图片就是"点击看原图"的入口（不显示任何文字） */
			/* 链接是图片的直接父级：它也得是同一个盒子，否则图片的 100%/100% 没有参照物。 */
			".ig-frameLink{display:block;width:100%;height:100%;border-radius:12px;text-decoration:none;color:inherit;cursor:zoom-in}",
			/* 应用内看原图浮层（左键点卡片弹出；桌面端 Electron 拦 target=_blank，只能自绘） */
			"[data-image-gen-viewer]{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;background:rgba(9,9,11,.86);cursor:zoom-out;overscroll-behavior:contain}",
			"[data-image-gen-viewer-img]{max-width:96vw;max-height:90vh;width:auto;height:auto;object-fit:contain;border-radius:10px;box-shadow:0 24px 64px rgba(0,0,0,.5);cursor:default;background:#0b0b0c}",
			"[data-image-gen-viewer-close]{position:absolute;top:18px;right:20px;display:flex;align-items:center;justify-content:center;width:36px;height:36px;border:0;border-radius:9999px;background:rgba(255,255,255,.16);color:#fff;font-size:20px;line-height:1;cursor:pointer}",
			"[data-image-gen-viewer-close]:hover{background:rgba(255,255,255,.28)}",
			".ig-error{margin:0;font-size:13px;color:var(--dsw-alias-state-error-primary);white-space:pre-wrap}",
			".ig-stage{margin:6px 0 0;font-size:12px;color:var(--dsw-alias-label-tertiary);text-align:center}",
			".ig-stage[data-image-gen-stage=\"optimize\"]::before{content:\"✦ \"}",
			/* ---- 聊天流侧：把「生图这一次调用」在消息流里彻底收掉，别的组一律不动 ----
			   上报口只留一个 0 尺寸的标记元素（`data-slot="image-gen-slot"`），CSS 靠它定位。
			   逐层收：成员行 → 只含它的组壳 → 该轮的耗时行。
			   **不藏整轮**：用户的提问必须留着，宿主的用户气泡也不动。 */
			/* 标记自身不占位（聊天流里不留任何像素）；可见性用 CSS 而非内联样式，
			   避免内联 display:none 影响 :has() 匹配。
			   标记带 data-image-gen-state：running = 动画还在这一行里放；
			   done = 图已落到 Turn 尾卡片，聊天流里这一行整行收掉。 */
			"[data-slot='image-gen-slot']{display:none!important}",
			/* 出图后：这一行在聊天流里不留痕迹（图片由 Turn 尾卡片呈现，见下） */
			"[data-chat-flow-kind='tool-call']:has([data-image-gen-state='done']){display:none!important}",
			/* 「这一组只有生图吗」必须在 CSS 里判，而 CSS **不允许 :has() 套 :has()**
			   （Chrome 直接把这个选择器判非法，整条规则失效）。所以标记器另外在
			   tool-call 行上打一个 data-image-gen-row（running|done），判定就变成
			   :not(:has(...:not([data-image-gen-row]))) —— 合法的 :not() 包 :has()。
			   组里只要还有别的步骤，下面两条就不命中，组头照常可以展开。 */
			"[data-step-process]:has([data-image-gen-row])" +
			":not(:has([data-chat-flow-kind='tool-call']:not([data-image-gen-row]))) > div:first-child{" +
			"display:none!important}",
			"[data-step-process]:has([data-image-gen-row='done'])" +
			":not(:has([data-chat-flow-kind='tool-call']:not([data-image-gen-row='done']))){display:none!important}",
			/* 生图轮的两行状态文字（"深度求索中，用时…" / "已完成，用时…"）收掉。
			   这两行**不是**生图行的祖先/后代，而是同级的独立 flowItem（实测：
			   button[data-turn-process="1"] 与 tool-call 行互为兄弟，没有公共的
			   [data-chat-turn] 容器），所以 :has() 关联不到、纯 CSS 也做不到
			   "同一个轮次才收"（CSS 不能比较属性值）。改由插件按轮次号找到它们、
			   打上 data-image-gen-quiet，这里只负责显示开关。 */
			"[data-image-gen-quiet]{display:none!important}",
			/* 生图动画不能被过程组的 max-height:400px 裁掉——否则 640 宽的动画只露出
			   上半截（用户反馈"动画太大、显示不全"）。只对含生图行的组解除高度限制。 */
			"[data-step-process-body]:has([data-image-gen-row]){max-height:none!important}",
			/* 生图轮的过程组里，除生图行之外的成员（模型调用工具前写的"我这就生成…"之类
			   助手文字、思考过程）也收掉——只留图片/动画本身。同样只在"这一轮的工具调用
			   全是生图"时生效，混合轮（还有别的工具）一个字都不动。
			   ⚠️ "这一支是不是生图行"必须用 :has([data-image-gen-state])：标记是我们自己渲染的，
			   一定在单元格内部（任何祖先的真后代）。而宿主真实 DOM 里 data-chat-anchor-key
			   与 data-image-gen-row 挂在**同一个元素**上，:has() 只匹配后代、不含自身——
			   写成 :has([data-image-gen-row]) 会把生图行自己也判成"别的成员"，
			   连动画一起 display:none（实测踩过，动画整个消失）。 */
			"[data-step-process]:has([data-image-gen-row])" +
			":not(:has([data-chat-flow-kind='tool-call']:not([data-image-gen-row])))" +
			" [data-chat-anchor-key]:not(:has([data-image-gen-state])){display:none!important}",
			/* 运行期：宿主会把过程组折起来（hidden="until-found" → content-visibility:hidden），
			   动画就在那一行里，折了就看不见。只强制展开**含运行中标记**的组内容，
			   已落地的组不动（它们本来就该收着）。 */
			"[data-step-process-body][hidden='until-found']:has([data-image-gen-state='running']){" +
			"content-visibility:visible!important;display:block!important}",
			"@media (prefers-reduced-motion:reduce){.ig-captionText{animation:none;background-image:none;color:rgba(255,255,255,.75)}.ig-caption{transition:none}}",
			/* Turn 尾卡片：图片的**唯一**展示面（在收尾文案下方、过程组之外，永不折叠）。 */
			".ig-turn{display:flex;flex-direction:column;gap:10px;margin:6px 0}",
			".ig-turn[hidden]{display:none}",
			".ig-note{margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary)}",
			/* ---- 设置页 · 图像模型（igm-*）：布局照官方「设置 · 模型」页，颜色全取宿主主题令牌 ---- */
			".igm-root{display:flex;flex-direction:column;gap:14px;max-width:760px;font-size:13px;color:var(--dsw-alias-label-primary)}",
			/* 设置页导航「图像模型」的图标（见 navIconMask / paintNavIcon） */
			"button[class*='navCell'][data-ig-nav]>svg{display:none!important}",
			"button[class*='navCell'][data-ig-nav]::before{content:\"\";flex:none;width:16px;height:16px;background-color:currentColor;-webkit-mask:" + navIconMask() + " center/contain no-repeat;mask:" + navIconMask() + " center/contain no-repeat}",
			".igm-head h2{margin:0;font-size:16px;font-weight:600}",
			".igm-head p{margin:4px 0 0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary)}",
			".igm-muted{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px}",
			".igm-alert,.igm-notice{display:flex;align-items:center;gap:6px;margin:0;padding:7px 10px;border-radius:8px;font-size:12px;line-height:1.5;border:1px solid var(--dsw-alias-border-l1);border-left-width:3px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}",
			".igm-alert{border-left-color:var(--dsw-alias-state-warn-primary,#b45309);color:var(--dsw-alias-state-warn-primary,#b45309)}",
			".igm-noticeOk{border-left-color:var(--dsw-alias-state-success-primary,#15803d);color:var(--dsw-alias-state-success-primary,#15803d)}",
			".igm-noticeFail{border-left-color:var(--dsw-alias-state-error-primary,#b91c1c);color:var(--dsw-alias-state-error-primary,#b91c1c)}",
			".igm-noticeRun{border-left-color:var(--dsw-alias-label-tertiary);color:var(--dsw-alias-label-secondary)}",
			/* 一列卡片行 */
			".igm-list{display:flex;flex-direction:column;gap:10px}",
			".igm-row{display:flex;align-items:center;gap:8px;padding:14px 16px;border-radius:12px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-primary)}",
			".igm-rowOn{border-color:var(--dsw-alias-brand-primary,#2563eb)}",
			".igm-rowName{font-size:14px;font-weight:500}",
			".igm-badge{padding:1px 7px;border-radius:6px;font-size:11px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-tertiary)}",
			".igm-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-tertiary);opacity:.35;flex:none}",
			".igm-dotOn{background:var(--dsw-alias-state-success-primary,#16a34a);opacity:1}",
			".igm-using{font-size:11px;color:var(--dsw-alias-brand-primary,#2563eb)}",
			".igm-warn{font-size:11px;color:var(--dsw-alias-state-warn-primary,#b45309)}",
			".igm-rowFill{flex:1}",
			/* 按钮：小号描边（使用/编辑）+ 红字（删除）+ 主按钮（保存） */
			".igm-btn{display:inline-flex;align-items:center;gap:5px;padding:5px 12px;border-radius:8px;font-size:12px;cursor:pointer;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-primary)}",
			".igm-btn:hover{background:var(--dsw-alias-bg-layer-2)}",
			".igm-btn:disabled{opacity:.45;cursor:default}",
			".igm-btnPrimary{background:var(--dsw-alias-brand-primary,#2563eb);border-color:transparent;color:#fff}",
			".igm-btnPrimary:hover{background:var(--dsw-alias-brand-primary,#2563eb);opacity:.9}",
			".igm-btnGhost{background:transparent;border-color:transparent;padding:5px 8px;color:var(--dsw-alias-label-secondary)}",
			".igm-del{padding:5px 8px;border:0;border-radius:8px;background:transparent;font-size:12px;cursor:pointer;color:var(--dsw-alias-state-error-primary,#dc2626)}",
			".igm-del:hover{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-state-error-primary,#dc2626)}",
			".igm-icon{flex:none}",
			/* 虚线整行「+ 添加图像模型」 */
			".igm-add{display:flex;align-items:center;justify-content:center;gap:6px;width:100%;padding:12px;border:1px dashed var(--dsw-alias-border-primary);border-radius:12px;background:transparent;font-size:13px;cursor:pointer;color:var(--dsw-alias-label-secondary)}",
			".igm-add:hover{border-color:var(--dsw-alias-brand-primary,#2563eb);color:var(--dsw-alias-brand-primary,#2563eb)}",
			/* 展开的表单：同一张卡片里 */
			".igm-form{display:flex;flex-direction:column;gap:12px;padding:16px;border-radius:12px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-primary)}",
			".igm-form h3{margin:0;font-size:14px;font-weight:600}",
			".igm-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px}",
			".igm-field{display:flex;flex-direction:column;gap:5px;min-width:0}",
			".igm-fieldLabel{font-size:12px;color:var(--dsw-alias-label-secondary)}",
			".igm-hint{font-style:normal;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}",
			".igm-input{flex:1;min-width:0;padding:6px 9px;border-radius:8px;border:1px solid var(--dsw-alias-border-primary);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12px;font-family:inherit}",
			".igm-input:focus{outline:2px solid var(--dsw-alias-brand-primary,#2563eb);outline-offset:-1px}",
			"select.igm-input{cursor:pointer}",
			/* 密钥：输入框 + 眼睛切换明文 */
			".igm-key{display:flex;align-items:center;gap:4px}",
			".igm-eye{display:flex;align-items:center;justify-content:center;width:28px;height:28px;flex:none;border:1px solid var(--dsw-alias-border-primary);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);cursor:pointer}",
			".igm-eye:hover{color:var(--dsw-alias-label-primary)}",
			/* 「从已添加的模型里提取」 */
			".igm-srcWrap{display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--dsw-alias-border-secondary,var(--dsw-alias-border-primary));padding-top:12px}",
			".igm-srcBody{display:flex;flex-direction:column;gap:10px;max-height:240px;overflow:auto;padding:10px;border-radius:10px;background:var(--dsw-alias-bg-layer-2)}",
			".igm-group{display:flex;flex-direction:column;gap:6px}",
			".igm-group h4{margin:0;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}",
			".igm-chips{display:flex;flex-wrap:wrap;gap:6px}",
			".igm-chip{padding:3px 9px;border:0;border-radius:9999px;font-size:11px;cursor:pointer;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary)}",
			".igm-chip:hover{color:var(--dsw-alias-brand-primary,#2563eb)}",
			".igm-formActions{display:flex;gap:8px}",
			".igm-opt{display:flex;flex-direction:column;gap:8px;padding:14px 16px;border-radius:12px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-primary)}",
			".igm-opt h3{margin:0;font-size:14px;font-weight:600}",
			".igm-optRow{display:flex;align-items:center;gap:10px;flex-wrap:wrap}",
			".igm-optSelect{min-width:280px;max-width:460px}",
		].join("\n");
		var cssDone = false;
		function ensureCss() {
			if (cssDone || typeof document === "undefined") return;
			cssDone = true;
			var el = document.createElement("style");
			el.setAttribute("data-plugin", NS);
			el.textContent = CSS;
			document.head.appendChild(el);
		}

		function parseJsonObject(raw) {
			if (typeof raw !== "string" || raw.trim() === "") return null;
			try {
				var value = JSON.parse(raw);
				return value && typeof value === "object" ? value : null;
			} catch (e) {
				return null;
			}
		}
		function imageRefs(content) {
			var out = [];
			(Array.isArray(content) ? content : []).forEach(function (block) {
				if (block && block.type === "image" && block.attachment) out.push({ attachment: block.attachment });
			});
			return out;
		}
		function textOf(content) {
			return (Array.isArray(content) ? content : [])
				.filter(function (b) {
					return b && b.type === "text" && typeof b.text === "string";
				})
				.map(function (b) {
					return b.text;
				})
				.join("\n")
				.trim();
		}
		function ratioOf(args, fallback) {
			var raw = args && typeof args.ratio === "string" ? args.ratio : "";
			var m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(raw);
			if (m) {
				var a = Number(m[1]);
				var b = Number(m[2]);
				if (a > 0 && b > 0) return a / b;
			}
			return fallback || 1;
		}

		/* 最近一次"确定过"的比例。模型没在参数里带 ratio 时（宿主会退回插件配置的
		   默认比例），动画至少要跟上一张图一致，而不是退化成 1:1 的方块。 */
		var lastAspect = 0;

		/**
		 * 解析这一轮该用的比例：
		 *   1) 参数里的 ratio（模型一般都会给，如 "16:9"）
		 *   2) 本次会话上一张图用过的比例
		 *   3) 1:1
		 * 动画与成图走同一个函数，所以「图是 16:9，动画就是 16:9」。
		 */
		function resolveAspect(args) {
			var a = ratioOf(args, 0);
			if (a > 0) {
				lastAspect = a;
				return a;
			}
			return lastAspect > 0 ? lastAspect : 1;
		}

		/* ==================================================================
		 *  同一个盒子：动画占位框与成图共用一套尺寸
		 *
		 *  用户要的是「动画的比例和大小跟图片一模一样」。要做到真的一样，
		 *  两边必须**从同一个函数拿尺寸**，而不是各写一遍 `min(100%, 72vh×比例)`
		 *  （各写一遍迟早会漂：动画用 aspect-ratio 取的是数学比例，
		 *   图片用内在尺寸取的是真实像素比——16:9 请求回来的图是 1312×736，
		 *   1.7826 而不是 1.7778，落地时就会轻轻跳一下）。
		 *
		 *  做法：盒子宽度只由「比例」决定，高度用 aspect-ratio 锁死，
		 *  图片改成 object-fit:cover 填满这个盒子——于是
		 *    · 动画框和图片是同一个像素盒子（宽高完全相同）
		 *    · 比例一致（都来自 aspect-ratio，不再依赖图片的原始像素）
		 *    · 万一请求比例与返回比例有细微差异，cover 会裁掉那 1 像素，不会变形
		 * ================================================================== */
		function boxStyle(aspect) {
			var ratio = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
			/* 显示尺寸＝原来的一半（用户要求"等比例缩小一半"）：
			   原来 640 宽 / 72vh 上限 → 现在 320 宽 / 36vh 上限；比例不变。
			   点开链接看的是原图（/image-gen/raw/<callId>/0），不受这里的缩放影响。 */
			return { width: "min(100%, calc(36vh * " + ratio + "))", aspectRatio: String(ratio) };
		}
		function routeUrl(callId, index) {
			return "/image-gen/raw/" + encodeURIComponent(callId) + "/" + index;
		}

		/* ==================================================================
		 *  应用内看原图浮层
		 *
		 *  为什么不用 target=_blank：桌面端是 Electron，宿主会把新窗口拦掉
		 *  （用普通 Chrome 测看着正常，用户点了却没反应）。这里用普通 DOM 自绘浮层
		 *  挂到 body 上——不依赖 react-dom（模块加载器只种了 react），
		 *  也不受消息流容器 transform/contain 影响（fixed 定位最稳）。
		 * ================================================================== */
		var viewerEl = null;

		function onViewerKey(event) {
			if (event.key === "Escape") {
				event.stopPropagation();
				closeViewer();
			}
		}

		function closeViewer() {
			if (!viewerEl) return;
			try {
				document.removeEventListener("keydown", onViewerKey, true);
				viewerEl.remove();
			} catch (err) {
				/* 节点可能已经被宿主清掉 */
			}
			viewerEl = null;
		}

		/** 全屏看原图：src 用持久同源路由，点背景/关闭键/ESC 关闭。 */
		function openViewer(src, alt) {
			if (typeof document === "undefined" || !src) return;
			closeViewer();
			var wrap = document.createElement("div");
			wrap.setAttribute("data-image-gen-viewer", "");
			wrap.setAttribute("role", "dialog");
			wrap.setAttribute("aria-modal", "true");
			wrap.setAttribute("aria-label", "原图预览");

			var img = document.createElement("img");
			img.setAttribute("data-image-gen-viewer-img", "");
			img.src = src;
			img.alt = alt || "原图";

			var close = document.createElement("button");
			close.type = "button";
			close.setAttribute("data-image-gen-viewer-close", "");
			close.setAttribute("aria-label", "关闭原图预览");
			close.textContent = "×";

			wrap.appendChild(img);
			wrap.appendChild(close);
			/* 点背景或关闭键关掉；点图片本身不关（用户正在看）。 */
			wrap.addEventListener("click", function (event) {
				if (event.target === wrap || event.target === close) closeViewer();
			});
			document.body.appendChild(wrap);
			viewerEl = wrap;
			document.addEventListener("keydown", onViewerKey, true);
		}

		/**
		 * generate_image 工具卡 = 聊天流里的图片卡片。
		 *
		 * 形态：卡片按图片自身比例铺满宽度（宽度 min(100%, 320px)，高度随比例、上限 36vh，
		 * 见下文的 stage 样式），每次生图在对话流里
		 * 它自己的位置出现，随对话流滚动。宿主给工具调用套的外壳（组头/耗时行/折叠）
		 * 用带 :has() 守卫的 CSS 收掉，只收「生图这一组/这一轮」，别的消息一律不动，
		 * 守卫锚点是 0 尺寸标记 image-gen-slot（由 GenerateImageMarker 渲染）。
		 *
		 * 两个席位：toolview 渲染卡片本体；额外一个「标记席位」供 CSS 定位收外壳。
		 * （标记不能省：toolview 的返回值在折叠组里，组壳收掉后标记也会消失，
		 *  所以标记挂在独立席位上，始终存在。）
		 */
		/* ==================================================================
		 *  落地记录：callId → 这一路的 loader / 附件
		 *  Tool 行只在**当轮**挂着（历史轮会被虚拟列表卸载），所以：
		 *    · 有 loader（当前轮 / 刚滚过的那一轮）→ 用 durable 附件地址
		 *    · 没有（隔了几屏、刷新后重放）→ 退回同源路由 /image-gen/raw/<callId>/<n>
		 *  两条地址都是宿主提供的持久通道，刷新与跨天都还能取到。
		 * ================================================================== */
		var liveCalls = new Map();
		/* 每条记录都攥着一个 loadImage 闭包，不清就会随会话单调增长（页面开一整天）。
		   只保留最近这些条：更老的图靠持久路由 /image-gen/raw/<callId>/<n> 取，
		   所以淘汰不影响显示，只是不再走 durable 附件那条快路径。 */
		var LIVE_CALLS_MAX = 120;
		function rememberCall(callId, patch) {
			if (!callId) return;
			var next = Object.assign({}, liveCalls.get(callId) || {}, patch);
			liveCalls.delete(callId);   // 重新插入以维持"最近使用"顺序
			liveCalls.set(callId, next);
			while (liveCalls.size > LIVE_CALLS_MAX) {
				var oldest = liveCalls.keys().next();
				if (oldest.done) break;
				liveCalls.delete(oldest.value);
			}
		}
		function loaderFor(callId) {
			var record = liveCalls.get(callId);
			return record && typeof record.loadImage === "function" ? record.loadImage : null;
		}

		/* ==================================================================
		 *  生图轮的状态行收口（"深度求索中，用时…" / "已完成，用时…"）
		 *
		 *  宿主的这两行是**同级独立 flowItem**，与生图那一行互为兄弟：
		 *    div.flowItem[data-chat-flow-kind=tool-call][data-chat-turn="1"]   ← 生图行
		 *    div.flowItem[data-chat-flow-kind=turn-process] > button[data-turn-process="1"]
		 *    div[data-chat-running]                                            ← 运行中那行
		 *  没有任何公共的 [data-chat-turn] 祖先能把它们用 :has() 关联起来，
		 *  CSS 也无法比较属性值（不能写"轮次号相同才收"）。所以由插件按轮次号
		 *  找到这两行、打上 data-image-gen-quiet，CSS 只负责 display:none。
		 * ================================================================== */
		var quietTurns = new Set();
		var quietMarked = new Map();
		var quietObserver = null;

		/* 打标记时记下元素，收尾时才能逐个摘掉。只回滚按钮、不管 flow 行的话，
		   这些属性会跟着被复用的 DOM 节点留下来（虚拟列表滚动/会话切换），
		   [data-image-gen-quiet]{display:none} 是全局规则 → 别的消息正文凭空消失。 */
		function markQuiet(turn, el) {
			if (!el || typeof el.hasAttribute !== "function" || el.hasAttribute("data-image-gen-quiet")) return;
			el.setAttribute("data-image-gen-quiet", "");
			var set = quietMarked.get(turn);
			if (!set) {
				set = new Set();
				quietMarked.set(turn, set);
			}
			set.add(el);
		}

		function unmarkQuiet(turn) {
			var set = quietMarked.get(turn);
			if (set) {
				set.forEach(function (el) {
					if (el && typeof el.removeAttribute === "function") el.removeAttribute("data-image-gen-quiet");
				});
			}
			quietMarked.delete(turn);
			var btn = document.querySelector('[data-turn-process="' + turn + '"]');
			if (btn) btn.removeAttribute("data-image-gen-quiet");
			/* 运行中状态行没有轮次号，只有还有生图轮在跑时才该收着 */
			if (quietTurns.size === 0) {
				var run = document.querySelector("[data-chat-running]");
				if (run) run.removeAttribute("data-image-gen-quiet");
			}
		}

		function syncQuiet() {
			if (typeof document === "undefined") return;
			var openImageTurn = false; // 有还没结束的纯生图轮 → 运行中状态行也要收
			quietTurns.forEach(function (turn) {
				var all = document.querySelectorAll('[data-chat-flow-kind="tool-call"][data-chat-turn="' + turn + '"]');
				var imageRows = document.querySelectorAll('[data-chat-flow-kind="tool-call"][data-chat-turn="' + turn + '"][data-image-gen-row]');
				/* 只有"这一轮的工具调用全是生图"才收；混合轮（还有别的工具）保留，
				   免得用户看不到"这一轮还干了别的什么"。 */
				if (all.length === 0 || all.length !== imageRows.length) return;

				var btn = document.querySelector('[data-turn-process="' + turn + '"]');
				if (btn) {
					markQuiet(turn, btn);
				} else {
					openImageTurn = true;
				}

				/* 这一轮里除「用户提问 / 图片卡片 / 生图行」以外的文字行（模型调用工具前
				   写的"我这就生成…"、思考块等）一并收掉——用户要求生图时上面不留文字。
				   普通轮不在 quietTurns 里，一个字都不动。 */
				document.querySelectorAll('[data-chat-flow-kind][data-chat-turn="' + turn + '"]').forEach(function (row) {
					var kind = row.getAttribute("data-chat-flow-kind");
					if (kind === "user" || kind === "turn-tail") return;
					if (row.hasAttribute("data-image-gen-row")) return;
					markQuiet(turn, row);
				});
			});
			if (!openImageTurn) return;
			var run = document.querySelector("[data-chat-running]");
			if (run && !run.hasAttribute("data-image-gen-quiet")) run.setAttribute("data-image-gen-quiet", "");
		}

		/* 宿主重渲染会重建这两行（我们的标记随之丢失），所以挂一个观察器持续对齐。
		   只对"我们打过的标记"做增量设置，且设置前先 hasAttribute 判断，
		   不会自己触发自己（无循环）。 */
		function ensureQuietObserver() {
			if (quietObserver || typeof MutationObserver !== "function" || typeof document === "undefined") return;
			var scheduled = false;
			quietObserver = new MutationObserver(function () {
				if (scheduled) return;
				scheduled = true;
				var run = function () {
					scheduled = false;
					syncQuiet();
				};
				if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
				else setTimeout(run, 16);
			});
			quietObserver.observe(document.body, {
				childList: true,
				subtree: true,
				attributes: true,
				attributeFilter: ["data-turn-process", "data-chat-running", "data-image-gen-row"],
			});
		}

		/* ==================================================================
		 *  Turn 尾卡片（图片的唯一展示面）
		 *
		 *  为什么不在工具行里出图：宿主对工具调用有一整套折叠机制——
		 *  ChatGroupSeat 里 `grouped = stepGrouping === 'collapsed' || …`，
		 *  回合结束后还有 `outerHidden = foldCompleted && turnClosed && stored.answerStep !== spec.answerStep`
		 *  （standard 档 foldCompletedTurns=true）→ 过程组连同里面的图片一起被 hidden。
		 *  这是"图片有时看不见"的根因，且在默认档位下必然发生。
		 *
		 *  官方给出的位置是 Turn 级卡片：`conversation.chat.turnTail` 渲染在收尾文案下方、
		 *  过程组**之外**（ui-schedule 的 schedule_create 卡片走的就是这条路：
		 *  Definition 把结果发布到 Turn，turnTail 席位渲染）。它不会被折叠，
		 *  而且靠会话日志重放就能重建——刷新页面后图片照样在。
		 * ================================================================== */
		var TURN_KEY = "image-gen-images";

		/** 只记数据、不产出视图节点的 Turn 级 Definition。 */
		var imageTurnDefinition = {
			kind: TURN_KEY,
			match: function (event) {
				if (!event || typeof event.type !== "string") return null;
				var data = event.data || {};
				if (event.type === "turn/start") return { id: String(data.turn), role: "start" };
				if (event.type === "tool/call") return { id: String(data.turn), role: "update" };
				if (event.type === "tool/result") return { id: String(data.turn), role: "update" };
				return null;
			},
			start: function (_context, match) {
				if (match.event.type !== "turn/start") throw new Error("image-gen-images start requires turn/start");
				return { turn: match.event.data.turn, calls: new Map(), images: [] };
			},
			update: function (context, match) {
				var event = match.event;
				var state = context.state;
				if (event.type === "tool/call") {
					var calls = new Map(state.calls);
					calls.set(String(event.data.callId), {
						name: event.data.name,
						argsRaw: event.data.arguments,
						seq: event.seq,
					});
					return { turn: state.turn, calls: calls, images: state.images };
				}
				if (event.type !== "tool/result") return state;
				var message = event.data.message || {};
				var callId = String((message.source && message.source.callId) || "");
				var call = state.calls.get(callId);
				if (!call || call.name !== TOOL) return state;
				var settled = settledImage(message, call, event);
				if (settled === null) return state;
				return {
					turn: state.turn,
					calls: state.calls,
					images: state.images.concat([settled]),
				};
			},
			buildLocationData: function (context, scope, previous) {
				if (scope !== "turn" || context.state === undefined) return null;
				var state = context.state;
				/* React 之外的引擎按引用判等：内容没变就交回同一个对象，避免无谓重渲染。 */
				if (
					previous &&
					previous.kind === "turn" &&
					previous.turn === state.turn &&
					previous.key === TURN_KEY &&
					previous.value &&
					previous.value.images === state.images
				) {
					return previous;
				}
				return { kind: "turn", turn: state.turn, key: TURN_KEY, value: { images: state.images } };
			},
		};

		/**
		 * 把一条 tool/result 收敛成"这一轮出了一张图"。
		 * 失败也记（卡片上显示错误），否则用户只看到动画消失、什么也没有。
		 * @returns 记录，或 null（这条结果不属于生图）。
		 */
		function settledImage(message, call, event) {
			var args = parseJsonObject(call.argsRaw) || {};
			var refs = message.isError === true ? [] : imageRefs(message.content);
			return {
				callId: String((message.source && message.source.callId) || ""),
				seq: Number.isFinite(event.seq) ? event.seq : 0,
				/* 事件时间（会话日志里的墙钟毫秒）：只有"刚刚出图"才播显影动画，
				   刷新/隔天重放的历史图 at 距今很远 → 直接显示，不重播。
				   取不到时间就记 0 = 不播（宁可少一次动画，也不要每次刷新都重播）。 */
				at: Number.isFinite(event.time) ? event.time : 0,
				prompt: typeof args.prompt === "string" ? args.prompt : "",
				aspect: resolveAspect(args),
				/* ⚠️ 全部附件都要留：只存 refs[0] 的话，配置 count>1 时多出来的图

				   会被静默丢掉（用户以为没生成）。attachment 保留为第 0 张，

				   兼容退回"画在工具行里"那条旧路径。 */

				attachments: refs.map(function (ref) { return ref.attachment; }),

				attachment: refs.length ? refs[0].attachment : null,

				count: refs.length,
				isError: message.isError === true,
				errorText: message.isError === true ? textOf(message.content) || "生图失败" : "",
			};
		}

		/** Turn 尾的图片组：这一轮生成了几张就排几张，一张都没有就不渲染。 */
		function GenerateImageTurnCard(props) {
			var turn = props && props.turn;
			var data = turn && turn.data && typeof turn.data.get === "function" ? turn.data.get(TURN_KEY) : undefined;
			var all = data && Array.isArray(data.images) ? data.images : [];
			if (all.length === 0) return null;
			/* 上界取这一轮的结束序号：收尾文案之后落地的结果也算这一轮的。 */
			var bound = turn && turn.end && Number.isFinite(turn.end.seq) ? turn.end.seq : props && props.seq;
			var images = Number.isFinite(bound) ? all.filter(function (item) { return item.seq <= bound; }) : all;
			if (images.length === 0) return null;
			/* 一次调用可以出 N 张（配置 count>1）：摊平成一格一张，
			   否则多出来的图没有任何展示面，用户以为只出了一张/没出。 */
			var cells = [];
			images.forEach(function (item) {
				var list = Array.isArray(item.attachments) && item.attachments.length ? item.attachments : [item.attachment];
				if (item.isError) list = [null];
				list.forEach(function (attachment, index) {
					cells.push({
						key: item.callId + ":" + index,
						callId: item.callId,
						index: index,
						prompt: item.prompt,
						aspect: item.aspect,
						at: item.at,
						attachment: item.isError ? null : attachment,
						isError: item.isError,
						errorText: item.errorText,
					});
				});
			});
			return h(
				"div",
				{ className: "ig-turn", "data-slot": "image-gen-turn", "data-image-gen-count": cells.length },
				cells.map(function (cell) {
					return h(SettledImage, { key: cell.key, item: cell });
				}),
			);
		}

		/** 一张已经落地的图：整张就是「打开原图」的链接，失败则显示原因。 */
		function SettledImage(props) {
			var item = props.item;
			var callId = String(item.callId || "");
			/* 第 index 张有自己的持久路由；写死 0 会让多张图全指向第一张。 */
			var routeSrc = routeUrl(callId, item.index || 0);
			var _src = useState(null);
			var src = _src[0];
			var setSrc = _src[1];

			useEffect(
				function () {
					if (item.isError || !item.attachment) return function () {};
					var loadImage = loaderFor(callId);
					if (typeof loadImage !== "function") return function () {};
					var live = true;
					Promise.resolve()
						.then(function () {
							return loadImage(item.attachment);
						})
						.then(function (url) {
							if (live && url) setSrc(url);
						})
						.catch(function () {
							/* 取不到就用同源路由，路由也拿不到时 <img> 自己兜底。 */
						});
					return function () {
						live = false;
					};
				},
				[callId, item.attachment],
			);

			if (item.isError) {
				return h("p", { className: "ig-error", role: "alert" }, item.errorText || "生图失败");
			}
			/* 只有"刚刚出图"才播显影动画；刷新/隔天重放的历史图直接显示，不重播。 */
			var fresh = item.at > 0 && Date.now() - item.at < 12000;
			return h(
				"div",
				{
					className: "ig-item",
					"data-slot": "image-gen-frame",
					"data-image-gen-call": callId,
					"aria-label": "图片生成结果",
				},
				h(
					"a",
					{
						className: "ig-frameLink",
						href: routeSrc,
						target: "_blank",
						rel: "noreferrer",
						title: "点击查看原图",
						/* 盒子定在链接上（与动画框同一个 boxStyle），图片 100% 填满它。 */
						style: boxStyle(item.aspect),
						/* 桌面端（Electron）里 target=_blank 会被宿主拦掉，点了没反应——
						   所以左键改成在应用内开浮层看原图；带修饰键的点击仍走默认（新窗口）。 */
						onClick: function (event) {
							if (!event || event.defaultPrevented) return;
							if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
							event.preventDefault();
							openViewer(routeSrc, item.prompt || "生成的图片");
						},
					},
					fresh
						? h(GridReveal, {
								src: src || routeSrc,
								alt: item.prompt || "生成的图片",
								aspect: item.aspect,
								fill: true,
								estimatedDuration: 12000,
							})
						: h("img", {
								className: "ig-image",
								src: src || routeSrc,
								alt: item.prompt || "生成的图片",
								// 图片只负责填满：尺寸由父级 .ig-frameLink 的盒子给出。
								style: null,
								onError: function () {
									if (src !== routeSrc) setSrc(routeSrc);
								},
							}),
				),
			);
		}

		/** 工具行里的卡片：**只负责生成中的动画**；出图后这一行被 CSS 收掉。 */
		function GenerateImageCard(props) {
			var phase = props.phase;
			var block = props.block || {};
			var callId = String(props.callId || "");
			var loadImage = props.loadImage;

			var running = phase !== "result";
			var refs = running ? [] : imageRefs(block.content);
			/* 参数从哪读（实测宿主 toolview 的 block 结构）：
			     生成中：block = { phase, callId, name, argsRaw, turn, step, time, subCalls }
			             → 参数在 **argsRaw**（早先读 block.arguments 拿不到，比例才退化成 1:1）
			     出图后：block.call.arguments
			   两条路径都试，保证动画与成图拿到同一个比例。 */
			var args =
				(running
					? parseJsonObject(block.argsRaw) || parseJsonObject(block.arguments)
					: parseJsonObject(block.call && block.call.arguments) || parseJsonObject(block.argsRaw)) || {};
			var aspect = resolveAspect(args);
			var prompt = (args && typeof args.prompt === "string" && args.prompt) || "";
			var isError = !running && block.isError === true;
			var rootRef = useRef(null);

			/* 这一行的 loader/附件要留给 Turn 尾卡片用：两者在 React 树里互不相邻，
			   而 turnTail 的 owner props 里只有 { turn, seq, openFile }。 */
			useEffect(
				function () {
					rememberCall(callId, {
						loadImage: loadImage,
						attachment: refs.length ? refs[0].attachment : null,
					});
				},
				[callId, loadImage, refs.length],
			);

			/* 在**宿主渲染的那一行**上打标记：CSS 才能判断"这一组是不是只有生图"
			   （:has() 不能套 :has()，见样式表里的说明）。行不是我们渲染的，
			   所以只能 ref + closest 往上找；卸载时摘掉，免得复用的 DOM 带着旧状态。 */
			useEffect(
				function () {
					var el = rootRef.current;
					if (!el || typeof el.closest !== "function") return function () {};
					var row = el.closest("[data-chat-flow-kind]");
					if (!row || typeof row.setAttribute !== "function") return function () {};
					row.setAttribute("data-image-gen-row", running ? "running" : "done");
					return function () {
						try { row.removeAttribute("data-image-gen-row"); } catch (err) { /* 卸载时行可能已经没了 */ }
					};
				},
				[running],
			);

			/* 收掉这一轮的两行状态文字（"深度求索中，用时…"/"已完成，用时…"）。
			   这两行与生图行是兄弟 flowItem，CSS 关联不到，只能按轮次号打标记
			   （见 syncQuiet 的说明）。轮次号取自我们所在的 [data-chat-turn] 容器。 */
			useEffect(
				function () {
					var el = rootRef.current;
					if (!el || typeof el.closest !== "function") return function () {};
					var host = el.closest("[data-chat-turn]");
					var turn = host ? host.getAttribute("data-chat-turn") : null;
					if (turn === null || turn === undefined) return function () {};
					quietTurns.add(turn);
					syncQuiet();
					ensureQuietObserver();
					return function () {
						quietTurns.delete(turn);
						unmarkQuiet(turn);
						syncQuiet();
					};
				},
				[],
			);

			/* 出图后：这一行只留一个 0 尺寸标记，行本身由 CSS 收掉——
			   图片在 Turn 尾卡片上（GenerateImageTurnCard）。
			   万一 Turn 尾席位没注册上（宿主 API 变了），退回旧行为：图就画在行里，
			   标记保持 running，让"强制展开过程组"那条 CSS 继续兜住可见性。 */
			if (!running && turnCardsReady) {
				return h(
					"div",
					{ className: "ig-root", ref: rootRef },
					h(GenerateImageMarker, { state: "done", callId: callId }),
				);
			}

			var settled = !running
				? h(SettledImage, {
						item: {
							callId: callId,
							prompt: prompt,
							aspect: aspect,
							index: 0,
							attachment: refs.length ? refs[0].attachment : null,
							isError: isError,
							errorText: isError ? textOf(block.content) : "",
						},
					})
				: null;

			return h(
				"div",
				{ className: "ig-root", ref: rootRef },
				h(GenerateImageMarker, { state: "running", callId: callId }),
				settled ||
					h(
						"div",
						{
							className: "ig-item",
							"data-slot": "image-gen-frame",
							"data-image-gen-call": callId,
							"aria-busy": true,
							"aria-label": "正在生成图片",
						},
						/* 成图与动画占位共用同一尺寸规则：宽 = min(列宽, 72vh×比例)。 */
						h(GridReveal, { src: null, alt: "", aspect: aspect, estimatedDuration: 12000 }),
						/* 阶段文字：优化提示词/生成图片/保存各有提示，等待全程有反馈 */
						h(GenerateStageText, { callId: callId }),
					),
			);
		}

		/**
		 * 等待阶段的文字：optimize（改写提示词）→ generate（画图）→ save（保存）。
		 * 用户要求"优化提示词时就要看得见动画/反馈"——阶段一变文字就换；
		 * 格子动画全程都在跑（占位框从挂载起就裂格呼吸），文字只负责说清在干什么。
		 * 轮询走同源 GET /image-gen/stage/<callId>：只读、无敏感数据、1.2s 一次。
		 */
		function GenerateStageText(props) {
			var callId = String(props.callId || "");
			var _stage = useState("optimize");
			var stage = _stage[0];
			var setStage = _stage[1];

			useEffect(
				function () {
					if (!callId) return function () {};
					var live = true;
					var timer = 0;
					var tries = 0;
					/* 链式 setTimeout（不是 setInterval）：到 save（终点）就停，不挂着空转。
					   ⚠️ stage 为 null 只是"宿主还没写阶段"（卡片挂在 execute 之前就会轮询到），
					   绝不能当成"读不到就放弃"——那样文字会永远停在第一句。
					   只在这三种情况停：终点 save、端点不可用、超过上限。 */
					function poll() {
						if (!live) return;
						if (++tries > 200) return;   // ≈4 分钟，兜住极端情况
						fetch("/image-gen/stage/" + encodeURIComponent(callId), { credentials: "same-origin" })
							.then(function (r) {
								if (!r.ok) return { stop: true };   // 端点不在（旧宿主半）→ 别刷了
								return r.json();
							})
							.then(function (j) {
								if (!live || !j) return;
								if (j.stop) return;
								if (j.stage) setStage(j.stage);
								if (j.stage === "save") return;   // 终点
								timer = setTimeout(poll, 1200);
							})
							.catch(function () {
								/* 网络异常就停在当前文案（阶段本来也只是锦上添花） */
							});
					}
					poll();
					return function () {
						live = false;
						clearTimeout(timer);
					};
				},
				[callId],
			);

			var text =
				stage === "optimize"
					? "正在优化提示词…"
					: stage === "save"
						? "正在保存图片…"
						: "正在生成图片…";
			return h("p", { className: "ig-stage", "data-image-gen-stage": stage }, text);
		}

		/** 收外壳用的 0 尺寸标记：挂在工具卡旁边，CSS 靠它把组壳/耗时行收掉。 */
		function GenerateImageMarker(props) {
			return h("span", {
				"data-slot": "image-gen-slot",
				/* running = 过程组要强制展开（动画在行里）；done = 这一行可以整行收掉。 */
				"data-image-gen-state": (props && props.state) || "running",
				"data-image-gen-call": (props && props.callId) || undefined,
				"aria-hidden": "true",
			});
		}

		/* ==================================================================
		 *  设置页 · 图像模型
		 *
		 *  图标取自 morphicons 所消费的那套数据（Lucide 24×24 stroke path）——
		 *  插件客户端半没有构建链，所以内联 path 字符串 + dangerouslySetInnerHTML。
		 *
		 *  ⚠️ 这里**不新增任何 inject 依赖**：依赖缺失会让条目激活失败，桌面端表现为
		 *  「web boot: 1 entry did not activate」→ 整个应用起不来（README 踩坑 #11）。
		 *  所以 remote 在回调里惰性取（ctx.remote.imageGen），取不到就提示、不抛。
		 *
		 *  ⚠️ 图像模型只存在插件自己的 models.json 里，绝不注册成 llm 适配器 ——
		 *  聊天里的模型选择器读的是 llm 的 provider 目录，不进那个目录就不可能出现。
		 * ================================================================== */
		var ICON_PATHS = {
			image: '<rect width="18" height="18" x="3" y="3" rx="2" ry="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />',
			plus: '<path d="M5 12h14" /><path d="M12 5v14" />',
			trash: '<path d="M10 11v6" /><path d="M14 11v6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />',
			star: '<path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z" />',
			pencil: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" /><path d="m15 5 4 4" />',
			check: '<path d="M20 6 9 17l-5-5" />',
			refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M8 16H3v5" />',
			close: '<path d="M18 6 6 18" /><path d="m6 6 12 12" />',
			link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />',
			sparkles: '<path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z" />',
			alert: '<circle cx="12" cy="12" r="10" /><line x1="12" x2="12" y1="8" y2="12" /><line x1="12" x2="12.01" y1="16" y2="16" />',
			chevron: '<path d="m6 9 6 6 6-6" />',
			eye: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" /><circle cx="12" cy="12" r="3" />',
			eyeOff: '<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49" /><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242" /><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143" /><path d="m2 2 20 20" />',
		};
		var KIND_LABELS = { standard: "标准协议", "openai-images": "OpenAI 兼容", custom: "自定义" };
		/* 下拉里能选的（宿主给 KIND_CHOICES）。standard 只剩内置那条在用，不再供新选。 */
		var FALLBACK_KINDS = ["openai-images", "custom"];
		var FALLBACK_SIZES = ["1K", "2K", "3K", "4K"];
		var FALLBACK_RATIOS = ["1:1", "3:4", "4:3", "16:9", "9:16", "2:3", "3:2", "21:9"];

		/** 按我们注册的那个 label 文本认出行来打标记；已打过就跳过（幂等，可反复调）。 */
		function paintNavIcon() {
			if (typeof document === "undefined" || !document.querySelectorAll) return;
			var cells = document.querySelectorAll("button[class*='navCell']");
			for (var i = 0; i < cells.length; i++) {
				var cell = cells[i];
				if (cell.getAttribute("data-ig-nav") === "1") continue;
				var label = cell.querySelector("[class*='navLabel']");
				if (!label || String(label.textContent || "").trim() !== NAV_LABEL) continue;
				cell.setAttribute("data-ig-nav", "1");
			}
		}
		function Icon(props) {
			return h("svg", {
				xmlns: "http://www.w3.org/2000/svg",
				width: props.size || 16,
				height: props.size || 16,
				viewBox: "0 0 24 24",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 2,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				className: "igm-icon",
				"aria-hidden": "true",
				focusable: "false",
				dangerouslySetInnerHTML: { __html: ICON_PATHS[props.name] || "" },
			});
		}
		function Btn(props) {
			return h(
				"button",
				{
					type: "button",
					className: "igm-btn" + (props.primary ? " igm-btnPrimary" : "") + (props.mini ? " igm-btnMini" : "") + (props.ghost ? " igm-btnGhost" : ""),
					disabled: !!props.disabled,
					onClick: props.onClick,
					title: props.title || undefined,
					"aria-label": props.title || undefined,
				},
				props.children,
			);
		}
		function Field(props) {
			return h(
				"label",
				{ className: "igm-field" },
				h("span", { className: "igm-fieldLabel" }, props.label),
				props.children,
				props.hint ? h("em", { className: "igm-hint" }, props.hint) : null,
			);
		}
		function Text(props) {
			return h("input", {
				className: "igm-input",
				type: props.password ? "password" : "text",
				value: props.value == null ? "" : String(props.value),
				placeholder: props.placeholder || "",
				onChange: function (event) {
					props.onInput(event && event.target ? event.target.value : "");
				},
			});
		}
		function Choice(props) {
			return h(
				"select",
				{
					className: "igm-input",
					value: props.value,
					onChange: function (event) {
						props.onInput(event && event.target ? event.target.value : "");
					},
				},
				(props.options || []).map(function (option) {
					return h("option", { key: option, value: option }, props.labels ? props.labels[option] || option : option);
				}),
			);
		}

		/**
		 * 设置页 · 图像模型。
		 *
		 * 布局照官方「设置 · 模型」页：一列卡片行（名称 + 自定义标记 + 绿点=已有密钥
		 * + 使用/编辑/删除），底部一条虚线「+ 添加图像模型」，展开后是同一个卡片里的表单，
		 * API 密钥直接在表单里填（password 输入框，可点眼睛明文查看）。
		 *
		 * 可以存多个模型，点「使用」把哪个设为当前生图用的模型。
		 */
		function ImageModelsSettings(props) {
			var call = typeof props.call === "function" ? props.call : null;
			var _list = useState({ models: [], defaultId: "", kinds: FALLBACK_KINDS, sizes: FALLBACK_SIZES, ratios: FALLBACK_RATIOS, optimizer: { provider: "", model: "" }, optimizeOn: true, loading: true, error: "" });
			var list = _list[0];
			var setList = _list[1];
			var _form = useState(null);
			var form = _form[0];
			var setForm = _form[1];
			var _reveal = useState(false);
			var reveal = _reveal[0];
			var setReveal = _reveal[1];
			var _sources = useState({ open: false, loading: false, groups: [], error: "" });
			var _optGroups = useState([]);
			var optGroups = _optGroups[0];
			var setOptGroups = _optGroups[1];
			var sources = _sources[0];
			var setSources = _sources[1];
			var _notice = useState(null);
			var notice = _notice[0];
			var setNotice = _notice[1];

			function applySnapshot(res) {
				setList({
					models: Array.isArray(res.models) ? res.models : [],
					defaultId: String(res.defaultId || ""),
					optimizer: res.optimizer && typeof res.optimizer === "object" ? res.optimizer : { provider: "", model: "" },
					optimizeOn: res.optimizeOn !== false,
					kinds: Array.isArray(res.kinds) && res.kinds.length ? res.kinds : FALLBACK_KINDS,
					sizes: Array.isArray(res.sizes) && res.sizes.length ? res.sizes : FALLBACK_SIZES,
					ratios: Array.isArray(res.ratios) && res.ratios.length ? res.ratios : FALLBACK_RATIOS,
					loading: false,
					error: res && res.ok === false ? String(res.error || "") : "",
				});
			}
			function send(payload) {
				if (!call) return Promise.resolve({ ok: false, error: "服务未就绪" });
				return call(payload).then(
					function (res) {
						if (res && res.models) applySnapshot(res);
						return res;
					},
					function (error) {
						var message = String((error && error.message) || error);
						setList(function (prev) {
							return Object.assign({}, prev, { loading: false, error: message });
						});
						return { ok: false, error: message };
					},
				);
			}

			/* 优化模型下拉的候选来自 llm 的 provider 目录（只读，绝不注册回去）。
			   拉不到就空着，用户仍可选「跟随当前会话」，不该为这个弹错误。 */
			useEffect(
				function () {
					if (!call) return function () {};
					var live = true;
					call({ action: "sources" }).then(function (res) {
						if (!live || !res || !Array.isArray(res.groups)) return;
						setOptGroups(res.groups.filter(function (g) {
							return g && g.provider && Array.isArray(g.models);
						}));
					}).catch(function () {});
					return function () {
						live = false;
					};
				},
				[call],
			);

			/* 提示条会一直挂着很碍眼：成功 4s、失败 8s 后自动收。 */
			useEffect(
				function () {
					if (!notice) return function () {};
					var timer = setTimeout(function () {
						setNotice(null);
					}, notice.kind === "fail" ? 8000 : 4000);
					return function () {
						clearTimeout(timer);
					};
				},
				[notice],
			);

			useEffect(
				function () {
					if (!call) {
						setList({ models: [], defaultId: "", kinds: FALLBACK_KINDS, sizes: FALLBACK_SIZES, ratios: FALLBACK_RATIOS, loading: false, error: "图像模型服务不可用（改过宿主半需要重启 DSH）" });
						return function () {};
					}
					var live = true;
					call({ action: "list" }).then(
						function (res) {
							if (live && res && res.models) applySnapshot(res);
						},
						function () {
							/* send 的失败路径已给提示，这里不重复 */
						},
					);
					return function () {
						live = false;
					};
				},
				[call],
			);

			/** 下拉选项：宿主给的可选项 + 当前这条自己的 kind。
			   存量行的 kind 可能不在可选项里（如内置那条）—— 必须补进去，
			   否则 select 会显示成第一项，用户点保存就把协议悄悄改掉了。 */
			function kindOptions(current) {
				var base = Array.isArray(list.kinds) && list.kinds.length ? list.kinds : FALLBACK_KINDS;
				return base.indexOf(current) >= 0 ? base : [current].concat(base);
			}

			function blankForm() {
				return { id: "", name: "", kind: list.kinds[0] || FALLBACK_KINDS[0], baseUrl: "", model: "", apiKey: "", keepKey: "", apiKeyEnv: "IMAGE_API_KEY", size: "2K", ratio: "1:1", timeoutMs: "300000" };
			}
			function startAdd() {
				setReveal(false);
				setNotice(null);
				setSources({ open: false, loading: false, groups: [], error: "" });
				setForm(blankForm());
			}
			function startEdit(model) {
				setReveal(false);
				setNotice(null);
				setForm({
					id: model.id,
					name: model.name,
					kind: model.kind,
					baseUrl: model.baseUrl,
					model: model.model,
					apiKey: "",
					keepKey: model.hasKey ? "已保存 " + (model.keyHint || "••••") : "",
					apiKeyEnv: model.apiKeyEnv,
					size: model.size,
					ratio: model.ratio,
					timeoutMs: String(model.timeoutMs),
				});
			}
			function patchForm(fields) {
				setForm(Object.assign({}, form, fields));
			}
			function save() {
				if (!form) return;
				var input = {
					name: form.name || form.model,
					kind: form.kind,
					baseUrl: form.baseUrl,
					model: form.model,
					apiKeyEnv: form.apiKeyEnv,
					size: form.size,
					ratio: form.ratio,
					timeoutMs: Number(form.timeoutMs) || 300000,
				};
				/* 留空 = 保持原密钥不变；填了才覆盖 */
				if (form.apiKey.trim()) input.apiKey = form.apiKey.trim();
				var res = form.id ? { action: "update", id: form.id, patch: input } : { action: "add", input: input };
				send(res).then(function (r) {
					if (r && r.ok !== false) {
						setForm(null);
						setNotice({ kind: "ok", text: form.id ? "已保存修改" : "已添加模型" });
					} else {
						setNotice({ kind: "fail", text: (r && r.error) || "保存失败" });
					}
				});
			}
			function use(model) {
				send({ action: "default", id: model.id }).then(function (r) {
					/* 成功就不弹条了：绿点和「使用中」自己会移过去，再弹一条反而吵 */
					if (!r || r.ok === false) setNotice({ kind: "fail", text: (r && r.error) || "切换失败" });
				});
			}
			function remove(model) {
				send({ action: "remove", id: model.id }).then(function (r) {
					if (r && r.ok === false) setNotice({ kind: "fail", text: r.error });
					else setNotice({ kind: "ok", text: "已删除 " + model.name });
					if (form && form.id === model.id) setForm(null);
				});
			}
			function testNow(model) {
				setNotice({ kind: "run", text: "正在测试 " + (model.name || model.model) + "…" });
				send({ action: "probe", id: model.id }).then(function (r) {
					setNotice(r && r.ok ? { kind: "ok", text: "连通正常（" + (r.ms / 1000).toFixed(1) + "s，出图 " + r.images + " 张）" } : { kind: "fail", text: (r && r.error) || "测试失败" });
				});
			}
			/* 优化模型下拉的值编码成 "组号:项号"：provider/model 自己可能带 "/"
			   （deepseek/deepseek-v4.1-flash），拼字符串切分会切错，只能按下标反查。 */
			function optValue() {
				var cur = list.optimizer || {};
				if (!cur.provider || !cur.model) return "";
				for (var g = 0; g < optGroups.length; g++) {
					var grp = optGroups[g];
					if (grp.provider !== cur.provider) continue;
					for (var i = 0; i < grp.models.length; i++) {
						if (grp.models[i].id === cur.model) return g + ":" + i;
					}
				}
				/* 选过但当前目录里没有（换机器/清过）：原样显示，别静默变回"跟随会话" */
				return "x:" + cur.provider + "|" + cur.model;
			}
			function saveOptimizer(value) {
				var provider = "";
				var model = "";
				if (value && value.indexOf("x:") === 0) {
					var rest = value.slice(2);
					var bar = rest.indexOf("|");
					provider = bar >= 0 ? rest.slice(0, bar) : rest;
					model = bar >= 0 ? rest.slice(bar + 1) : "";
				} else if (value) {
					var parts = value.split(":");
					var grp = optGroups[Number(parts[0])];
					var item = grp && grp.models[Number(parts[1])];
					if (!grp || !item) return;
					provider = grp.provider;
					model = item.id;
				}
				send({ action: "setOptimizer", provider: provider, model: model }).then(function (r) {
					setNotice(r && r.ok !== false
						? { kind: "ok", text: provider ? "优化模型已设为 " + provider + " / " + model : "已改为跟随当前会话的模型" }
						: { kind: "fail", text: (r && r.error) || "保存失败" });
				});
			}

			function loadSources() {
				if (sources.open) {
					setSources({ open: false, loading: false, groups: [], error: "" });
					return;
				}
				setSources({ open: true, loading: true, groups: [], error: "" });
				send({ action: "sources" }).then(function (res) {
					setSources({
						open: true,
						loading: false,
						groups: (res && Array.isArray(res.groups) ? res.groups : []).filter(function (g) {
							return g && g.provider;
						}),
						error: res && res.unavailable ? String(res.unavailable) : "",
					});
				});
			}
			function pickSource(group, model) {
				patchForm({ name: model.label || model.id, model: model.id, kind: "openai-images", baseUrl: String(group.baseUrl || "") });
			}

			function Row(model) {
				var active = model.id === list.defaultId;
				return h(
					"div",
					{ key: model.id, className: "igm-row" + (active ? " igm-rowOn" : "") },
					h("span", { className: "igm-rowName" }, model.name),
					model.builtin ? null : h("span", { className: "igm-badge" }, "自定义"),
					h("span", { className: "igm-dot" + (active ? " igm-dotOn" : ""), title: active ? "当前使用中" : "未选中" }),
					active ? h("span", { className: "igm-using" }, "使用中") : null,
					/* 密钥配在环境变量里时 hasKey 是 false，但模型照样能用 —— 看 keyReady。 */
					model.keyReady === false ? h("span", { className: "igm-warn" }, "未配置密钥") : null,
					h("span", { className: "igm-rowFill" }),
					h(Btn, { mini: true, disabled: active, onClick: function () { use(model); } }, "使用"),
					h(Btn, { mini: true, onClick: function () { startEdit(model); } }, "编辑"),
					model.builtin ? null : h("button", { type: "button", className: "igm-del", onClick: function () { remove(model); } }, "删除"),
				);
			}

			function FormRow() {
				if (!form) return null;
				var editing = !!form.id;
				return h(
					"div",
					{ className: "igm-form" },
					h("h3", null, editing ? "编辑模型" : "添加图像模型"),
					h(
						"div",
						{ className: "igm-grid" },
						h(Field, { label: "显示名称" }, h(Text, { value: form.name, placeholder: "例如 我的图像模型", onInput: function (v) { patchForm({ name: v }); } })),
						h(Field, { label: "接口类型" }, h(Choice, { value: form.kind, options: kindOptions(form.kind), labels: KIND_LABELS, onInput: function (v) { patchForm({ kind: v }); } })),
						h(
							Field,
							{ label: "API 密钥", hint: form.keepKey ? form.keepKey + "（留空表示不修改）" : "只保存在本机插件目录，不会回传到页面" },
							h(
								"div",
								{ className: "igm-key" },
								h(Text, { value: form.apiKey, password: !reveal, placeholder: "sk-…", onInput: function (v) { patchForm({ apiKey: v }); } }),
								h(
									"button",
									{
										type: "button",
										className: "igm-eye",
										title: reveal ? "隐藏" : "显示",
										onClick: function () {
											setReveal(!reveal);
										},
									},
									h(Icon, { name: reveal ? "eyeOff" : "eye", size: 14 }),
								),
							),
						),
						h(
							Field,
							{ label: "Base URL", hint: form.kind === "custom" ? "完整地址，直接 POST" : "站点根地址，插件自己拼 /v1/images/generations" },
							h(Text, { value: form.baseUrl, placeholder: "https://your-image-api.example.com", onInput: function (v) { patchForm({ baseUrl: v }); } }),
						),
						h(Field, { label: "模型名", hint: "请求里真正发送的 model" }, h(Text, { value: form.model, placeholder: "your-model-name", onInput: function (v) { patchForm({ model: v }); } })),
						h(
							Field,
							{ label: "环境变量名（可选）", hint: "不想把密钥写在这里时，填变量名，从系统环境或 ~/.dsh/.env 读" },
							h(Text, { value: form.apiKeyEnv, placeholder: "IMAGE_API_KEY", onInput: function (v) { patchForm({ apiKeyEnv: v }); } }),
						),
						h(Field, { label: "默认档位" }, h(Choice, { value: form.size, options: list.sizes, onInput: function (v) { patchForm({ size: v }); } })),
						h(Field, { label: "默认宽高比" }, h(Choice, { value: form.ratio, options: list.ratios, onInput: function (v) { patchForm({ ratio: v }); } })),
						h(Field, { label: "超时（毫秒）" }, h(Text, { value: form.timeoutMs, placeholder: "300000", onInput: function (v) { patchForm({ timeoutMs: v }); } })),
					),
					h(
						"div",
						{ className: "igm-srcWrap" },
						h(Btn, { mini: true, ghost: true, onClick: loadSources }, h(Icon, { name: "link", size: 13 }), "从已添加的模型里提取"),
						sources.open
							? h(
									"div",
									{ className: "igm-srcBody" },
									sources.loading ? h("p", { className: "igm-muted" }, "读取模型目录中…") : null,
									sources.error ? h("p", { className: "igm-muted" }, sources.error) : null,
									!sources.loading && !sources.error && sources.groups.length === 0 ? h("p", { className: "igm-muted" }, "没有读到已添加的模型，直接在上面填也可以。") : null,
									sources.groups.map(function (group) {
										return h(
											"div",
											{ key: group.provider, className: "igm-group" },
											h("h4", null, group.provider),
											h(
												"div",
												{ className: "igm-chips" },
												group.models.slice(0, 40).map(function (model) {
													return h(
														"button",
														{
															key: group.provider + "/" + model.id,
															type: "button",
															className: "igm-chip",
															onClick: function () {
																pickSource(group, model);
															},
														},
														model.label,
													);
												}),
											),
										);
									}),
								)
							: null,
					),
					h(
						"div",
						{ className: "igm-formActions" },
						h(Btn, { primary: true, disabled: !form.model, onClick: save }, "保存"),
						h(Btn, { onClick: function () { setForm(null); setNotice(null); } }, "取消"),
					),
				);
			}

			return h(
				"div",
				{ className: "igm-root" },
				h(
					"header",
					{ className: "igm-head" },
					h("h2", null, "图像模型"),
					h("p", null, "填入各图像模型的 API 密钥即可点击使用；这些名称不会出现在聊天输入框的模型选择器里。"),
				),
				list.error ? h("p", { className: "igm-alert" }, h(Icon, { name: "alert", size: 13 }), list.error) : null,
				notice ? h("p", { className: "igm-notice igm-notice" + (notice.kind === "fail" ? "Fail" : notice.kind === "run" ? "Run" : "Ok") }, notice.text) : null,
				h(
					"section",
					{ className: "igm-opt" },
					h("h3", null, "提示词优化模型"),
					h(
						"p",
						{ className: "igm-muted" },
						list.optimizeOn
							? "生图前先用它把简短想法改写成结构化英文提示词（主体、构图留白、风格、光影）；超时或失败自动回退原文，不影响出图。"
							: "插件配置 optimize: false，当前已跳过优化，直接用原始提示词生图。",
					),
					h(
						"div",
						{ className: "igm-optRow" },
						h(
							"select",
							{
								className: "igm-input igm-optSelect",
								value: optValue(),
								disabled: !call,
								onChange: function (event) {
									saveOptimizer(event && event.target ? event.target.value : "");
								},
							},
							h("option", { value: "" }, "跟随当前会话的模型"),
							optGroups.map(function (group, gi) {
								return h(
									"optgroup",
									{ key: group.provider, label: group.label || group.provider },
									group.models.map(function (model, mi) {
										return h("option", { key: group.provider + "/" + model.id, value: gi + ":" + mi }, model.label || model.id);
									}),
								);
							}),
							optValue().indexOf("x:") === 0
								? h("option", { value: optValue() }, "已选：" + optValue().slice(2).replace("|", " / "))
								: null,
						),
						optGroups.length === 0 ? h("span", { className: "igm-muted" }, "没有读到可选模型，可先用「跟随当前会话」") : null,
					),
				),
				list.loading
					? h("p", { className: "igm-muted" }, "载入中…")
					: h(
							"div",
							{ className: "igm-list" },
							list.models.map(function (m) {
								/* key 必须挂在这个数组元素上：写在 Row 返回的 div 上 React 看不到，
								   会退化成按下标复用（编辑态可能挂到错误的那一行）。 */
								return h(Row, Object.assign({ key: m.id }, m));
							}),
						),
				FormRow(),
				form
					? null
					: h(
							"button",
							{ type: "button", className: "igm-add", disabled: !call, onClick: startAdd },
							h(Icon, { name: "plus", size: 14 }),
							"添加图像模型",
						),
			);
		}

		/* 设置页的 remote 调用器：apply 里绑定 ctx 后填进来（惰性取 remote.imageGen）。 */
		var callImageModels = null;
		var SECTION_INJECT = {
			call: function (payload) {
				if (typeof callImageModels !== "function") return Promise.resolve({ ok: false, error: "图像模型服务未就绪" });
				return callImageModels(payload);
			},
		};

		/* ---------- cordis 客户端插件入口 ---------- */
		/* uiConversation 是 ui-conversation 包提供的客户端服务（super(ctx, "uiConversation")），
		   注册 Turn 级 Definition 走它的 events 注册表。它在 web 客户端里必然存在——
		   本插件的客户端半本来就挂在 ui-chat 上，而 ui-chat 的渲染离不开 ui-conversation。 */
		var inject = ["slots", "remote", "uiConversation"];

		/** Turn 尾席位是否注册成功。失败就退回"图还画在工具行里"的旧行为，绝不让图彻底消失。 */
		var turnCardsReady = false;

		function apply(ctx) {
			ensureCss();

			/* 0) 注册 remote 贡献。$mount 同步抛错会变成「web boot: 1 entry did not activate」
			       → 整个桌面端起不来，所以单包一层。 */
			try {
				var mounted = ctx.remote.$mount(CONTRIBUTION);
				if (mounted && typeof mounted.then === "function") mounted.then(null, function () {});
			} catch (err) {
				/* remote 挂不上只是少一个 remote 接口，生图与卡片照常工作 */
			}

			/* 1) Turn 级 Definition：把每一轮里 generate_image 的落地结果发布到 Turn 上。
			      注册失败只是少一块卡片，不该连累整个客户端激活。 */
			try {
				var events = ctx.uiConversation && ctx.uiConversation.events;
				if (events && typeof events.register === "function") {
					events.register(imageTurnDefinition);
					turnCardsReady = true;
				}
			} catch (err) {
				turnCardsReady = false;
			}

			/* 2) 工具行席位：生成中播 GridReveal；出图后只留 0 尺寸标记，行交给 CSS 收掉。 */
			// ⚠️ register 必须包在 ctx.slots.inject(席位名, …) 里——裸 register 在真实 ctx 上会抛，
			// 桌面端表现为「web boot: 1 entry did not activate」，是之前应用打不开的根因（README 踩坑 #11）。
			ctx.effect(function () {
				try {
					return ctx.slots.inject("tool.call.toolview", function () {
						return ctx.slots.register({ name: "tool.call.toolview", key: TOOL }, function (slotProps) {
							return h(GenerateImageCard, {
								phase: slotProps && slotProps.phase,
								block: slotProps && slotProps.block,
								callId: slotProps && slotProps.callId,
								loadImage: slotProps && slotProps.loadImage,
							});
						});
					});
				} catch (err) {
					/* 席位缺失只少一块动画，不能让条目激活失败 */
					return function () {};
				}
			}, "image-gen: tool cell");

			/* 3) Turn 尾席位：图片的展示面。渲染在收尾文案下方、过程组之外，永不折叠。 */
			ctx.effect(function () {
				try {
					return ctx.slots.inject("conversation.chat.turnTail", function () {
						return ctx.slots.register(
							{ name: "conversation.chat.turnTail", id: NS, order: 30 },
							GenerateImageTurnCard,
						);
					});
				} catch (err) {
					return function () {};
				}
			}, "image-gen: turn card");

			/* 4) 设置页 · 图像模型。
			   ⚠️ 数据走同源 fetch("/image-gen/models")，**不走 ctx.remote.imageGen**：
			   要拿到那个命名空间就得把它写进 inject 名单，而 inject 里任何一项缺失
			   都会让条目激活失败 → 整个桌面端起不来（README 踩坑 #11）。
			   同理整段包在 try 里：没有设置页席位也只是少一个页面，生图照常工作。 */
			try {
				callImageModels = function (payload) {
					if (typeof fetch !== "function") return Promise.resolve({ ok: false, error: "当前环境不支持 fetch" });
					return fetch("/image-gen/models", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						credentials: "same-origin",
						body: JSON.stringify(payload || { action: "list" }),
					})
						.then(function (response) {
							if (!response || !response.ok) return { ok: false, error: "图像模型服务不可用（HTTP " + (response && response.status) + "）" };
							return response.json();
						})
						.catch(function (error) {
							/* 宿主半改了必须重启 DSH 才生效；没重启时这里是 404/网络错误 */
							return { ok: false, error: "读不到图像模型服务（改过宿主半请重启 DSH）：" + String((error && error.message) || error) };
						});
				};

				/* 导航图标要**在用户点进这一行之前**就显示，所以打标不能放在页面组件里
				   （组件是点了才挂载的，成了鸡生蛋）。设置面板是 portal 到 body 的，
				   只观察 body 的直接子节点（subtree:false）就够：聊天流式输出改的是深层
				   节点，不会触发这里，代价近乎零；我们自己的 setAttribute 也不算 childList，
				   不会自激。面板插进来之后 React 可能还要一两帧才把导航行填好，
				   所以每次触发跑一个**有界**重试阶梯，跑完就停，不留常驻定时器。 */
				ctx.effect(function () {
					var timers = [];
					function cancelAll() {
						for (var i = 0; i < timers.length; i++) clearTimeout(timers[i]);
						timers = [];
					}
					function ladder() {
						cancelAll();
						[0, 60, 180, 400].forEach(function (delay) {
							timers.push(setTimeout(paintNavIcon, delay));
						});
					}
					var observer = typeof MutationObserver === "function" ? new MutationObserver(ladder) : null;
					if (observer) observer.observe(document.body, { childList: true, subtree: false });
					ladder();
					return function () {
						if (observer) observer.disconnect();
						cancelAll();
					};
				}, "image-gen: nav icon");
				ctx.effect(function () {
					return ctx.slots.inject("settings.section", function () {
						return ctx.slots.register(
							{ name: "settings.section", id: NS + "-models", order: 60, label: "图像模型" },
							function () {
								return h(ImageModelsSettings, SECTION_INJECT);
							},
						);
					});
				}, "image-gen: settings");
			} catch (err) {
				/* 没有设置页席位（或宿主 API 变了）：只是少一个设置页，生图照常工作。 */
			}
		}
		exports.apply = apply;
		exports.inject = inject;
		// 仅供测试断言移植过来的 GridReveal 数学（模块加载器只读 apply/inject）
		exports.__gridReveal = {
			CELLS: CELLS,
			HOLD: HOLD,
			WAIT_CAP: WAIT_CAP,
			LAST_SPLIT: LAST_SPLIT,
			OPENING_CELLS: OPENING_CELLS,
			buildTree: buildTree,
			selfPaced: selfPaced,
			clamp01: clamp01,
			smoothstep: smoothstep,
			easeOut: easeOut,
			measureTree: measureTree,
			orderByDetail: orderByDetail,
			drawScene: drawScene,
			GridReveal: GridReveal,
		};
		return module.exports;
	},
});
