# Milestone 3 — 基础收付款（2026-10-03）

按用户新优先级，在红包之前实现收款与付款。M0 余额已由用户确认，M0 真实转账、M1 铸币与转账均仍待用户验收；不将自动化测试记作真实交易成功。

## 本轮代码

- 商家收款码：选择收款代币后生成 长期有效的可复用码，客户扫码自行输入金额；每次付款独立生成 intentId/nonce/reference，商家复核该金额后补签。成功后 Done 返回原商家码。
- 客户显示 **Gas fee: 0 SOL**，同时注明商家支付网络费和新收款账户租金。此显示仅适用于商家承担费用的请求，不代表链上不收费。
- 收款：输入金额，选择 USDC / 已加载的 AAPLx-DEMO，默认 USDC；选择费用承担方，默认收款方/商家。
- 生成 10 分钟有效的 Devnet Payment Intent，显示二维码；提供完整文本供模拟器粘贴。
- 付款：原生摄像头扫码、文本输入和 `tappay://pay` 深链进入同一验证与复核流程，不直接授权资金转移。
- 当前可执行的支付路径为同币种转账。其他已支持资产会显示“conversion unavailable”，不会把选择代币伪装成兑换。
- 二维码校验网络、版本、接收地址、mint/program、标准化金额、随机 intentId/nonce/reference、期限、费用策略和允许的支付资产。
- 请求仅支持 USDC 与 M1 的不可变 ×2 Token-2022 演示 profile。外来 demo mint 先链上校验，再用于本次付款。
- 费用承担方同时支付新收款 ATA 的租金，界面明确单列网络费和租金估算。网络费上限 0.00002 SOL，拒绝额外 compute-budget 指令或任意转账；当前无兑换费或服务费。
- 签名交易在广播前保存；部分签名交出后也保存，未确认前锁定再次发送。重启、回到前台和手动按钮都可查原付款。
- 链上收据核对 token owner、实际 fee payer、接收 ATA、mint/program、raw amount、reference 和绑定请求的 memo。双方读 Solana 确认结果。
- 扫码只申请相机权限，不申请录音。用户拒绝权限后可重新授权或打开系统设置。

## 商家代付协议：双向二维码

无需中心支付服务器：

1. 商家连接自己的钱包，创建收款码，费用默认由商家承担。
2. 顾客扫收款码，核对完整收款地址、代币和金额，查看费用后确认钱包。
3. 顾客签署 **token transfer authority**，商家是交易的 **fee payer**。顾客此时不用支付 SOL；交易缺商家签名，尚未广播。
4. App 在本机保存部分签名交易，展示“顾客授权码”。它绑定原请求，不能改收款人或金额。
5. 商家扫顾客授权码。App 按原请求重建规范交易并逐字节比对 message，验证顾客签名、区块哈希有效性、余额、mint、费用与租金。
6. 商家复核并通过钱包补签同一 message；原顾客签名必须保留。签名齐全后先保存实际交易签名，再广播。
7. 商家按交易签名、顾客按 reference + 自己的原签名查询链上，匹配后显示 **Paid ✓**。

若收款人选择“付款方承担”：顾客钱包一次签名，保存并广播，不需要商家扫码补签。

真实签名交换依据：[Solana Partial Signing](https://solana.com/docs/core/transactions/partial-signing)。网络费即使交易失败也可能收取：[Solana fees](https://solana.com/docs/core/fees/fee-structure)。

## 恢复与限制

- 交接二维码使用近期 blockhash，通常比 10 分钟收款请求更早失效。过期授权不能换 blockhash 复用旧签名。
- 顾客交出签名后，不能直接关闭并重新付款。需确认该笔成功、失败，或 finalized blockhash 已失效且链上历史查询未找到原付款。
- 历史查询缺失、RPC 错误或超出安全扫描上限时保持阻止重付，不把“不知道”当成“失败”。收款方最近 20 条参考交易用于收款发现；顾客授权恢复最多查询 3 页、每页 100 条，超过上限明确阻止自动解锁。
- 付款准备时会拒绝已发现的已支付请求，商家补签前再次检查。但普通 SPL 转账没有全局消费 nonce 的合约；不能保证多个恶意/并发客户端绝不重复支付同一个请求，也不能在链上强制执行客户端 expiresAt。
- 收款请求过期后仍可能收到此前签署的交易。关闭过期请求前检查钱包；界面不将“请求过期”当成“付款失败”。
- 本地签名交接与钱包部分签名兼容性、真实摄像头扫码、双设备转账均待设备验收。没有操作用户钱包或进行真实付款。
- 跨币种转换属于 M4，NFC 属于 M5，本轮未实现。红包仍需等额/拼手气两种模式，未开始。

## 自动化验证

```sh
npm run typecheck
npm test
```

60 个测试通过，包含长期商家码、旧版期限兼容与单笔请求继续过期的检查，包括旧有功能回归及新费用模式、缩放资产请求、二维码生成/编解码、过期/重复请求、任意指令与签名篡改、缺失签名、费用上限、存储失败、广播超时、收据身份和部分签名恢复。

新增运行依赖：Expo SDK 55 对应的 expo-camera、react-native-svg，以及 qrcode 的纯 JS 核心。安装时 npm 报告 36 个依赖审计告警（12 moderate / 24 high）；没有进行可能改变 Expo/Solana SDK 兼容性的强制升级。这些告警未在本里程碑修复。

## 本轮构建产物

Android arm64 release 构建成功（包含商家开放金额收款码），未安装或操作用户钱包。

- APK：`apps/mobile/android/app/build/outputs/apk/release/app-release.apk`
- 大小：34,827,306 bytes
- SHA-256：`b5a72f27437c16ad9f967032b22833ee5886daa3b17397bdcefc3183ea1f5199`

## 安装与设备验证

```sh
JAVA_HOME=/Users/victor/Library/Java/JavaVirtualMachines/corretto-17.0.20/Contents/Home \
ANDROID_HOME=/Users/victor/Library/Android/sdk npm run apk:android
~/Library/Android/sdk/platform-tools/adb install --no-streaming -r apps/mobile/android/app/build/outputs/apk/release/app-release.apk
```

### 默认商家承担费用

1. 两台 Android 设备/模拟器安装本版 App 和支持 MWA 部分签名的钱包，选择 Devnet。
2. 商家钱包准备 Devnet SOL，顾客钱包准备 Devnet USDC；可用无 SOL 的顾客钱包验证代付。
3. 商家连接钱包 → Receive → 默认 USDC → 输入 5 → 保留 Receiver / merchant → Show receive QR。
4. 顾客连接钱包 → Scan to pay → 扫码并核对地址/金额/代币/费用 → Review payment costs → Confirm payment in wallet。
5. 顾客展示授权码；商家点 Scan customer authorization，扫码后核对顾客地址、网络费、租金，再点 Approve fees in merchant wallet。
6. 两端应显示 Paid ✓；在交易详情核对实际 fee payer 是商家、转账 authority 是顾客、商家收到 5 USDC。

### 商家码：客户输入金额

1. 商家 Receive → 选择收款代币（默认 USDC）→ Show merchant QR — customer enters amount。
2. 客户 Scan to pay → 扫商家码 → 输入 2.75 → 确认 Gas fee: 0 SOL 与商家承担提示 → Review entered amount。
3. 继续检查费用、钱包签名，再由商家扫客户授权码并补签；商家签名前必须显示 2.75 与正确代币。
4. 两端确认 Paid 后，商家 Done 返回原收款码；第二笔输入不同金额应生成独立付款，不继承前一笔 Paid 状态。
5. 验证空金额、0、负数、超出代币精度、篡改金额/商家 codeId/reference 均被拒绝。新生成的商家码长期有效，单笔请求仍最多 10 分钟；旧版 24 小时码保留原期限，需重新生成一次长期码。

### 其他必测路径

- 新建请求选择 Payer：只需顾客签名；验证网络费和新 ATA 租金由顾客承担。
- 选择同一 AAPLx-DEMO mint 收 1 个显示单位：链上 transferChecked 应为 500000 raw units。
- 顾客拒签、商家拒签、账户切换、商家 SOL 不足、授权过期：不能显示 Paid 或悄悄改由顾客付费。
- 顾客生成授权码后重启：应恢复同一授权码，不能重复付款；商家广播超时后查原签名。
- 修改任一二维码中的金额、接收人、fee policy、nonce、交易或签名：拒绝。
- 相机拒绝权限：提示授权/设置；模拟器可复制二维码下方完整文本，用 Read payment QR text 完成双向交接。
- 固定金额请求已支付后再次扫码：拒绝，要求新收款码；商家开放金额码可以继续接收独立付款。

## 下一阶段

Milestone 4：明确标注 demo 的 AAPLx-DEMO → USDC 兑换结算，补齐不同支付币种与收款币种之间的真实 Devnet 流程。不开启真实 xStocks、Mainnet 或未实现的交易路径。
