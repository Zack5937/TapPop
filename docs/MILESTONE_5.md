# Milestone 5 — Android NFC 标签入口

2026-10-03 按用户“继续”推进 M5。实现静态 NDEF 标签的发现/收款请求传输，沿用已有钱包确认和结算逻辑。没有执行安装、碰标签、钱包签名或真实付款；硬件验收由用户进行。

## 本轮实现

- Expo config plugin 持久配置 Android NFC 权限、可选硬件特性和三个精确的 `NDEF_DISCOVERED` URI host：`tappay://pay`、`tappay://merchant`、`tappay://settle`。反复 prebuild 不重复注册，不覆盖原有 VIEW/启动过滤器。
- NFC 硬件声明为 `required=false`，没有 NFC 的设备仍能安装，保留二维码和文本入口。
- 已检查本项目 React Native 0.83 的 IntentModule 与新架构 ReactHostImpl：冷启动 `getInitialURL` 和已运行时 `url` 事件均支持 `ACTION_NDEF_DISCOVERED`。NFC 和普通深链进入相同链接路由，再由原 M3/M4 handler 校验与复核。
- M3 长期商家码、固定金额请求和 M4 未签名演示请求增加 **Prepare NFC tag**：显示完整 URI、NDEF 消息字节需求、期限提示，并能通过系统分享发送标签链接。
- 长期商家码不设过期时间，客户碰标签后输入金额。固定金额请求/M4 请求保留原期限，新建请求后需要重写标签。
- 标签准备只允许收款请求，不导出客户签名授权、结算签名交易或交接分片。
- 增加 **Open NFC settings** 与无 NFC/设置不可用时的扫码回退提示。

Android 的 NDEF 标签分发根据第一条记录的 URI 匹配活动，因此写入时必须使用第一条 **NDEF URI / URL** 记录，不能用普通 text 记录。[Android NFC basics](https://developer.android.com/develop/connectivity/nfc/nfc)

## 资金边界

碰标签只携带请求，不证明商家身份，也不授权扣款。仍需核对完整收款地址、代币、金额、费用策略、Devnet mint 与期限，并显式点击钱包确认。M3 商家代付仍需商家补签；M4 仍需客户、商家、演示流动性钱包签名。NFC 不绕过本地未决付款锁、存储恢复或链上确认。

本文件记录最初的系统 NDEF 标签方案；用户随后要求的手机对手机 HCE/Reader Mode 已实现，见 [手机碰传扩展](MILESTONE_5_PHONE_TAP.md)。未使用 Android Beam 或蓝牙。标签写入使用外部 NFC 写入工具，本 App 不改写或锁定标签。

## 文件

- `apps/mobile/plugins/withPaymentNfc.cjs`、`apps/mobile/app.json`：可复现的原生 NFC 声明。
- `apps/mobile/src/paymentLinks.ts`：统一链接路由、标签请求校验与 NDEF 长度。
- `apps/mobile/src/components/NfcRequest.tsx`：标签准备、系统分享、NFC 设置与回退说明。
- `Checkout.tsx`、`DemoSettlement.tsx`：复用支付入口与收款请求。
- `apps/mobile/tests/paymentLinks.test.ts`：标签载荷、过期、路由、禁止签名数据写标签、prebuild 幂等及可选硬件测试。

## 自动化验证

```sh
npm run typecheck
npm test
JAVA_HOME=/Users/victor/Library/Java/JavaVirtualMachines/corretto-17.0.20/Contents/Home \
ANDROID_HOME=/Users/victor/Library/Android/sdk npm run apk:android
```

类型检查和 74 项测试通过（69 项回归 + 5 项 NFC/路由测试），Android release 构建完成。无新增运行依赖。检查最终 APK 的 NFC 权限、可选特性和三条 NDEF 过滤器；这些检查不能替代真机射频/标签验收。

## 静态标签版本历史产物

当前 APK 已更新为手机碰传版本，最新校验值见 [手机碰传扩展](MILESTONE_5_PHONE_TAP.md)。

- APK：`apps/mobile/android/app/build/outputs/apk/release/app-release.apk`
- 大小：34,861,098 bytes
- SHA-256：`03f62b2a1bf052b113be6087dcb36989ed76b6c45366ae99b8edf5a0c01db042`
- 最终 APK 已用 aapt 确认：targetSdk 36，NFC permission，可选 NFC feature，以及 pay/merchant/settle 三条 NDEF 过滤器。

## 真机验证

1. 安装新 APK 并至少启动一次。准备支持 NFC 的 Android 客户手机和可写 NDEF 标签，打开系统 NFC 并解锁屏幕。
2. 商家连接钱包，创建长期商家码：Receive → Show merchant QR → Prepare NFC tag。核对地址与代币。
3. 将显示的完整链接复制或分享给 NFC 写入工具，作为第一条 URI/URL 记录写入。工具应报告标签容量足够；界面的字节数是 NDEF 消息大小，标签格式本身还有额外开销。不要把二维码图片或普通文本记录写入代替 URI。
4. 客户手机碰标签。应打开 Tap Pay 的输入金额页，显示正确收款地址/代币和客户 0 SOL gas；到此不应弹出钱包签名或广播交易。
5. 客户输入金额并继续复核、钱包签名，再按 M3 商家补签流程结算。确认前不得显示 Paid。
6. 分别从 App 未运行和已运行时碰标签。已有未决付款时不得覆盖原签名或绕过结算检查。
7. 固定金额码重复相同流程，应直接显示指定金额；过期码应拒绝。M4 用 **Pay with demo stock** 内的 Prepare NFC tag，碰标签应进入 M4 的报价/三方复核页。
8. 手机无 NFC 或 NFC 关闭时验证 QR/文本入口仍可用；设置按钮不可用应给出明确提示。

软件分发回退测试：用合法且未过期的完整 URI 替换下方变量。此命令只模拟 Android intent，不验证真实 NFC，不会签名付款。

```sh
PAYMENT_URI='粘贴 Prepare NFC tag 显示的完整链接'
~/Library/Android/sdk/platform-tools/adb shell "am start -W -a android.nfc.action.NDEF_DISCOVERED -d '$PAYMENT_URI' -n com.onchainpayments.devnet/.MainActivity"
```

## 已知限制

- 真机 NFC、标签容量/写入、系统分发和钱包付款均待用户验收；本轮没有用模拟器分发结果代替真实碰一碰。
- 首次打开或多个 App 注册相同 scheme 时，系统可能显示应用选择；使用前核对实际打开的 App 与收款信息。
- M4 标签通常比商家码大，标签容量不足时使用原 QR/深链回退；不截断内容，不依赖短链服务器。
- 长期商家码仍是 M3 同币种收款，未接入 M4 跨币种路由。签名交接继续用二维码/文本。
- 当前 Android target SDK 36；将来提高 target 时需重新核对平台 NFC 分发权限变化，不能直接给主 Activity 增加权限而破坏普通钱包/深链入口。

## 下一里程碑

M2 通用代币红包：先完成拼手气链上随机分配与可操纵性设计审查，再实现等额/拼手气共用的 create、claim、ClaimRecord 防重复与资金守恒。此轮未开始红包代码。
