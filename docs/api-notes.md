# sports.sjtu.edu.cn 接口侦察笔记（2026-11-01，学生账号实测）

> 本文件是调研记录，不是最终方案。所有结论均在真实账号上验证过。

## 1. 会话

- 鉴权方式：`JSESSIONID`（HttpOnly、会话级 cookie，浏览器关闭即失效，不落盘）。
- 未登录访问受保护接口 → `302 Location: /login`（返回若依登录页 HTML），可用作掉线探测。
- 掉线恢复：把浏览器导航到
  `https://jaccount.sjtu.edu.cn/oauth2/authorize?response_type=code&client_id=mB5nKHqC00MusWAgnqSF&redirect_uri=https://sports.sjtu.edu.cn/oauth2Login&state=8`
  → 自动回到 `/pc/` 且已登录（jaccount 侧会话仍在时无需输密码）。
- 仅凭落盘的 `JATrustCookie` 走 OAuth **不够**：jaccount 会 302 到 `/jaccount/jalogin?...` 登录页。
  即：Python 侧无法只靠 cookie 静默续期，要么有密码，要么留在浏览器里跑。

## 2. 数据接口（全部 JSON，同源）

| 用途 | 方法 | 路径 | body |
|---|---|---|---|
| 日期列表 | POST | `/manage/fieldDetail/queryFieldReserveSituationIsFull` | `{id: venueId, feildType: venTypeId, date: "YYYY-MM-DD"}` → `data[] = {date, dateId, isAll, open}`，共 8 天 |
| 格子数据 | POST | `/manage/fieldDetail/queryFieldSituation` | `{fieldType: venTypeId, date, venueId, dateId}` → `data[] = {fieldName, fieldDetailStatus, fieldId, priceList[]}` |
| 规则校验 | POST | `/venue/personal/checkRule` | form-urlencoded `{venueId, venTypeId, scheduleDate, tension}`，`msg=="正常"` 才可约 |
| 公钥 | POST | `/getPublicKey` | → `data.publicKey` |
| 下单 | POST | `/venue/personal/ConfirmOrder` | AES 密文，见 §3 |
| 取消 | POST | `/tRefundReceipt/tRefundReceipt/createUserReceipt` | form `{orderId, type:"2"}` → `{"msg":"取消成功","code":"4"}` |
| 支付跳转 | POST | `/venue/personal/orderImmediatelyPC` | `{orderId}` → 跳到 `https://cwc2.jdcw.sjtu.edu.cn/payment/pay/pay.action?...` |

`dateId` 是服务端加密串，必须原样带回；每次调用会重新签发（前缀相同、整体不同），新旧都能用。

### 格子状态码（已用 UI 交叉验证）

| status | UI 类名 | 含义 |
|---|---|---|
| `0` | `unselected-seat` | **可预约** |
| `-1` | `bought-seat` | 不可约（已满 / 未到放号 / 营业时间外） |
| `-3` | `bought-seat` | 不可约（另一种） |
| `-2` | `bought-seat` | 已过期时段 |
| `1` | `selected-seat` | 自己已选中 |

每格 `{status, count, price, sign}`：`count` = 剩余名额（可约时为 23~25，不可约时为 0），`sign` 为服务端签名串，随格子一起走。

15 个时间槽固定 `07:00–08:00 … 21:00–22:00`（`priceList` 下标即槽位）。

## 3. 下单请求格式（抓包实录）

```
POST /venue/personal/ConfirmOrder
Content-Type: application/json;charset=utf-8
sid: RSA(随机16位 key)        // key 取自 [0-9A-Z]，= AES 的密码
tid: captchaVerification      // 本次实测为空字符串
tim: RSA(毫秒时间戳字符串)
body: Base64( AES-128-ECB-PKCS7( JSON({venTypeId, venueId, fieldType, scheduleDate,
        week, spaces, tenSity, dateId, returnUrl}), key ) )
```

- AES 与 RSA 的实现见 `recon/chunks/9.js` 里的 `Aes.encrypt` / `Rsa.encrypt`：
  CryptoJS `AES.encrypt(Utf8.parse(v), Utf8.parse(key), {mode: ECB, padding: Pkcs7}).toString()`（输出 base64）。
- 密文/头部不对时服务端直接返回纯文本 `unauthorized`。
- 成功：`{"msg":"操作成功","code":0,"data":"<订单号>"}`，随后前端跳 `/orderDetails/0`。
- 前端逻辑里存在 `code==1002 → 弹 AJ-Captcha 滑块` 的分支，**本次真实下单未触发，无验证码**。
  峰值（12:00 放号）是否开启风控未知。

前端下单是两步：`立即下单`（弹"预订须知"对话框）→ 勾选同意 → `提交订单`（此时才发 ConfirmOrder）。

## 4. 实测结论

- 轮询 `queryFieldSituation` 单次约 25ms，连打 10 次无异常/无限流迹象。
- **完整下单链路可纯 HTTP 复现**，一次成功（订单 `1102786553446666240`，￥5），随后已取消。
- 取消后名额回到 `count`，格子恢复 `status=0`。
- 偶发：短时间连续跨场馆批量查询时，个别响应会全部返回 `-1`（疑似瞬时缓存/聚合抖动），单场馆连查 6 次稳定。监控逻辑需以"看到 0 才动作"而非"-1 就断言已满"。

## 5. 场馆/类型 ID

见 `recon/` 下脚本与本文附表；健身房相关：

| 场馆 | venueId | 健身房 venTypeId | tension |
|---|---|---|---|
| 霍英东体育中心 | 9096787a-bc53-430a-9405-57dc46bc9e83 | b3dce013-3a0e-45e0-a0c2-425a364ac90f | 4 |
| 学生中心 | d784ad7c-cb24-4282-afd6-a67aec68c675 | 7d46c0a4-3ae6-4398-822b-d4b7b37085fa | 4 |
| 子衿街学生活动中心 | 768214ba-3b1c-4f29-ad00-15c0e376b000 | 0a349309-1734-4507-98bd-4c30bf33c6bc | 4 |
| 南洋北苑健身房 | 73b17f69-6ed9-481f-b157-5e0606a55fd5 | dad366b3-7db9-4043-865c-7177aff83efa | 1 |
| 徐汇校区体育馆 | db75ba81-ae54-4f22-ad5e-84de039f5a89 | 0f71f5e1-2e24-4c15-b437-cc9f82a1343e | 3 |
| 黄浦校区体育馆 | b6a6e986-dc17-4e3c-a62b-cb46bc6d87ac | ecce5fa1-3c42-4b8c-83a9-bec50fc43d24 | 3 |
| 张江校区体育运动中心 | 93284352-aad3-4353-8448-aad2b1526da1 | fce51858-9a8f-4499-a926-435e6127e8ae | 1 |

2026-11-01 19:35 的快照：霍英东 / 学生中心 / 子衿街 未来几天全满；南洋北苑 11-02~11-08 的 12:00–21:00 全空。

## 6. 规则约束（官网使用须知 / SJTU-Wiki）

- 「严禁使用"外挂"或其他手段预约场地，一经发现，加入黑名单，取消预约场地权限。」
- 支付：进支付页后 15 分钟内付完，超时自动取消（状态 8）。
- 取消：需提前 2 小时；"紧张/很紧张"场地 7 天内最多取消 5 次（成功订单）。
- 爽约：核销窗口 = 时段开始前 15 分钟 ~ 时段结束；半年内第 2 次禁约 1 个月。
- 每天 12:00 放 7 天后的号（日期列表恒给 8 天）。

## 7. 下单链路的补充实测（2026-11-01 晚，脚本联调）

- **`checkRule` 是"建议性"的，不拦人**：`/venue/personal/checkRule` 正常时返回
  `{"msg":"操作成功","code":0,"data":2}`，不是前端代码里判断的 `msg=="正常"`；
  而 `frequencyId` 这个变量在打包后的代码里只写不读（没有模板消费它）。真正的规则校验发生在
  `ConfirmOrder` 内部。→ 抢位时不要在这里浪费一次往返。
- **`orderImmediatelyPC`**：form `{orderId}` → `{"msg":"操作成功","code":0,"data":{"sign","sysid","subsysid","data"}}`，
  `data.data` 是 **URL 编码过的 GBK XML**（含 billno/amt/returnURL），直接拼进
  `https://cwc2.jdcw.sjtu.edu.cn/payment/pay/pay.action?data=…&sign=…&subsysid=…&sysid=…` 即可。
  注意 `data.data == 3` 时前端走"无需支付"分支。
- **取消的两种结果**：
  - 未生成支付单前取消 → `{"msg":"取消成功","code":"4"}`
  - 已调用过 `orderImmediatelyPC` 再取消 → `{"msg":"退款记录已生成","code":"1"}`，订单页显示"退款受理中(待退款）"
- **订单列表**：`GET /venue/personal/personalOrderlist?pageNo=1&pageSize=10`，返回键是 **`records`**（不是 `rows`），
  每行 `orderstateid`（如 13=取消/退款中）、`pOrderid`、`spaceInfo`。POST 不支持。
- 前端路由（hash）：`#/Order` 我的订单、`#/orderDetails/:type` 订单详情、`#/apointmentDetails/:state/:id/:isType/:bizId` 选座页。
- 页面 Vue 根实例上有现成的 `Aes` / `Rsa`（`document.getElementById('app').__vue__.Aes/Rsa`），
  脚本直接复用，AES-128-ECB 与页面实现逐字节一致（已验证）。

## 8. 登录态（两层）

- **场馆站**：`JSESSIONID`，会话级 cookie（无 Max-Age），只存在浏览器内存，**关浏览器即丢**；
  服务端闲置超时会回收，靠请求活动续命。未登录访问受保护接口 → `302 Location: /login`。
- **统一身份认证**：`jaccount.sjtu.edu.cn` 的独立会话（含持久化的 `JATrustCookie`）。
  `JATrustCookie` **单独不足以认证**——只用它跑 OAuth 仍会 302 到 `/jaccount/jalogin`，
  说明还需要 jaccount 侧的内存会话。故纯后台进程无法只凭 cookie 静默续期。
- **续期方式**（脚本采用）：整页跳
  `https://jaccount.sjtu.edu.cn/oauth2/authorize?response_type=code&client_id=mB5nKHqC00MusWAgnqSF&state=8&redirect_uri=<origin>/oauth2Login`，
  会话在线时静默回跳并重建 JSESSIONID；离线时落到登录页，人工登录后同样回到 `/pc/`。
- **登录态探测**：`GET /system/user/currentUser` → 已登录返回 `data.userName`；未登录 `{code:0}` 无 `data`（不报错，注意别按 code 判断）。
