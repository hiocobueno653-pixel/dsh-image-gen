/**
 * 路由栅栏单测。
 *
 * 背景：插件用 webServer.register() 自注册的路由**不经过**宿主鉴权管道
 * （只有 /api 通道走 connection.admit()）。曾经这里没挡，实测不带 cookie
 * 就能读模型配置、GET ?action=remove 改数据、action=probe 白烧生图额度。
 * 跑法：node test/fence.test.mjs
 */
import { fenceLocal, fenceRequest } from '../src/cordis.js';

let failures = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || detail === undefined ? '' : ' — ' + detail));
  if (!ok) failures++;
};
const req = (headers) => ({ headers });
const PASS = undefined;

/* ---------- 本地栅栏（/raw）---------- */
check('回环 Host 放行', fenceLocal(req({ host: '127.0.0.1:19387' })) === PASS);
check('localhost 放行', fenceLocal(req({ host: 'localhost:19387' })) === PASS);
check('缺 Host 拒绝', fenceLocal(req({})) === 403);
check('非回环 Host 拒绝（挡 DNS rebinding）', fenceLocal(req({ host: 'attacker.example:19387' })) === 403);
check('跨站 sec-fetch-site 拒绝（挡网页 <img> 打本机）',
  fenceLocal(req({ host: '127.0.0.1:19387', 'sec-fetch-site': 'cross-site' })) === 403);
check('Origin 与 Host 不一致拒绝',
  fenceLocal(req({ host: '127.0.0.1:19387', origin: 'http://evil.example' })) === 403);
check('Origin 自洽放行',
  fenceLocal(req({ host: '127.0.0.1:19387', origin: 'http://127.0.0.1:19387' })) === PASS);
check('同源资源加载（无 Origin 头）放行 —— 不能挡坏图片显示',
  fenceLocal(req({ host: '127.0.0.1:19387', 'sec-fetch-site': 'same-origin' })) === PASS);
check('null Origin（sandbox iframe）拒绝',
  fenceLocal(req({ host: '127.0.0.1:19387', origin: 'null' })) === 403);
check('坏 Origin 值拒绝而不是抛异常',
  fenceLocal(req({ host: '127.0.0.1:19387', origin: 'not a url' })) === 403);

/* ---------- 写端点栅栏（/models）---------- */
const fakeConn = { requestRejection: r => (r.headers.cookie ? PASS : 401) };
check('有 connection 时用宿主判定：无 cookie → 401',
  fenceRequest(fakeConn, req({ host: '127.0.0.1:19387' })) === 401);
check('有 connection 时用宿主判定：带 cookie → 放行',
  fenceRequest(fakeConn, req({ host: '127.0.0.1:19387', cookie: 'dsh-auth-x=v1.a.b' })) === PASS);
check('connection 抛错时 fail closed（绝不放行）',
  fenceRequest({ requestRejection: () => { throw new Error('boom'); } }, req({ host: '127.0.0.1:19387' })) === 403);
check('拿不到 connection 退回本地栅栏：跨站仍拒',
  fenceRequest(undefined, req({ host: '127.0.0.1:19387', 'sec-fetch-site': 'cross-site' })) === 403);
check('拿不到 connection 退回本地栅栏：本机同源放行（设置页不至于全瘫）',
  fenceRequest(undefined, req({ host: '127.0.0.1:19387' })) === PASS);
check('connection 缺 requestRejection 方法也退回本地栅栏',
  fenceRequest({}, req({ host: '127.0.0.1:19387', 'sec-fetch-site': 'cross-site' })) === 403);

console.log('');
console.log(failures ? `失败 ${failures} 项` : '全部通过：栅栏既挡住跨站，也不挡坏本机资源加载');
process.exit(failures ? 1 : 0);
