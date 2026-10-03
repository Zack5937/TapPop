# M5 扩展 — 手机对手机 NFC 碰传

2026-10-03 用户明确要求实现手机对手机碰传。本轮在静态标签方案之外实现 Android HCE 发送端与 Reader Mode 接收端。代码、原生编译和自动化测试完成；未安装 APK、未操作钱包、未验证两台真机射频通信。

## 已实现

双方安装同版 App，发送手机选择 **Send to nearby phone**，接收手机在相应支付区域选择 **Read nearby phone**，保持解锁并靠近 NFC 天线。无需 NFC 实体标签。

- 发送端：`HostApduService` 提供当前会话的不可变载荷快照，使用 `CATEGORY_OTHER` 与独立演示 AID，不替换系统默认银行卡/钱包。
- 接收端：`enableReaderMode` + NFC-A / ISO-DEP，读取专用 APDU 协议。收齐完整链接后交给原 M3/M4 validator 与付款处理器。
- M3：支持长期商家码、指定金额请求，以及客户签名授权码。客户碰商家手机读请求；客户确认钱包后，可反向发送授权给商家补签。
- M4：支持完整未签名请求与三方签名交易交接。碰传的是完整数据，接收方不用逐张扫描 QR 分片。
- 保留静态 NFC 标签、二维码、文本与深链作为回退。

Android HCE 可与 Android ISO-DEP 读卡端通信，发送端需具备 HCE 能力；双方都要启用 NFC。[Android HCE](https://developer.android.com/develop/connectivity/nfc/hce) 接收期间启用 Reader Mode，退出后关闭。[NfcAdapter API](https://developer.android.com/reference/android/nfc/NfcAdapter)

## 会话与协议

- 不写磁盘、不保存私钥、不自动签名。发送数据来自当前已验证请求/已保存签名交易。
- 只有用户主动开启、App 保持前台且未超时的会话才能被读取；内存发布窗口为 60 秒。离开前台、取消、销毁或超时清除发布数据与读卡状态。
- 原生层要求 NFC 已开启；发送端额外要求 HCE。未支持的设备明确提示使用 QR。
- 单次 SELECT 返回协议版本、总字节数和 SHA-256；每次读取最多 220 字节，整体最多 7,000 字节。接收端拒绝版本错误、超限、缺块、错误状态字和摘要不一致。
- 每次选择绑定同一发布对象；期间更换/停止发布或超时，后续读取会被拒绝，不拼接新旧请求。
- 原生接收在工作线程执行，读卡等待可取消；原生与 JS 都限制会话时间。独立 session ID 阻止旧会话的晚到回调取消或覆盖新会话。
- HCE 服务受 `android.permission.BIND_NFC_SERVICE` 保护，只供系统 NFC 分发绑定；`requireDeviceUnlock=true`。NFC/HCE 都声明为可选硬件。
- 协议摘要只保证分段完整性，不证明对方身份。支付安全仍来自地址/mint/金额/费用/期限校验、完整交易重建、钱包签名和链上结果核对。
- 演示 AID 为本项目自定义值；它不是正式注册的支付网络标识。生产分发前需评估 AID 注册与冲突。

## 不会在碰传时发生的操作

接收到收款请求只进入金额输入或支付复核。接收到签名交接数据只进行原有签名/请求验证；新增签名仍需明确点击并在钱包确认。Paid 仍由 Solana 确认的匹配交易决定，不能由 NFC 读取成功触发。

## 修改文件

- `apps/mobile/native/phone-tap/`：纯 Kotlin APDU 协议、HCE 服务、React Native 桥接、Package、资源声明与协议测试。此目录是源文件，prebuild 会复制到 Android 工程。
- `apps/mobile/plugins/withPhoneTap.cjs`：幂等配置 HCE 服务、可选能力、MainApplication 注册与原生测试依赖。
- `apps/mobile/src/components/PhoneTap.tsx`：发送/接收会话弹窗、能力检查、取消与超时处理。
- `apps/mobile/src/phoneTapPayload.ts`：传输入口限制；收到数据后仍调用已有业务验证。
- `NfcRequest.tsx`、`Checkout.tsx`、`DemoSettlement.tsx`：请求和签名交接的手机碰传入口。
- `app.json`、`tests/phoneTap.test.ts`、`tests/demoSettlement.test.ts`：配置与回归测试。

## 验证结果与命令

类型检查通过；78 项 JS/TypeScript 测试通过；6 项 Kotlin/JVM 协议测试通过；Android arm64 release APK 编译通过。

协议测试覆盖多段传输、未选择/停止/过期会话、切换发布、非法 APDU/越界读取、数据篡改/截断/超限和源缓冲区变化。JS 测试覆盖原请求/签名不变、外来载荷拒绝、M4 完整交接数据、HCE 权限与插件幂等注册。它们不等同于真实 NFC 链路、后台切换或钱包验收。

```sh
npm run typecheck
npm test
JAVA_HOME=/Users/victor/Library/Java/JavaVirtualMachines/corretto-17.0.20/Contents/Home \
ANDROID_HOME=/Users/victor/Library/Android/sdk npm run apk:android
cd apps/mobile/android
JAVA_HOME=/Users/victor/Library/Java/JavaVirtualMachines/corretto-17.0.20/Contents/Home \
ANDROID_HOME=/Users/victor/Library/Android/sdk NODE_ENV=production \
./gradlew :app:testReleaseUnitTest --max-workers=4 --console=plain
```

新增 `junit:junit:4.13.2` 仅用于原生单元测试，不进入运行时 APK；没有新增第三方 NFC 运行依赖。Kotlin 模块与 RN 已有 native module 互操作注册，实际设备桥接仍待验收。

## 最新构建产物

- APK：`apps/mobile/android/app/build/outputs/apk/release/app-release.apk`
- 大小：34,866,902 bytes
- SHA-256：`e04ae8b3fe3538291ff79a370f3ce718cbcf6040707b37898b8ecb4854732e8f`
- 最终 APK 已用 aapt/aapt2 确认 HCE 服务及 BIND_NFC_SERVICE 权限，NFC/HCE 均为可选特性；MainApplication 注册了 PhoneTapPackage。

## 两台真机操作

1. 两台 Android 安装最新 APK，开启 NFC、解锁屏幕并打开 App。发送端必须支持 HCE；接收端必须支持 NFC-A / ISO-DEP。
2. 商家连接钱包 → Receive → 显示长期商家码或固定金额码 → **Send to nearby phone**。保持发送弹窗打开。
3. 客户连接钱包 → Receive / Pay 区域的 **Read nearby phone**。将两台手机背面 NFC 天线区域靠近，保持到接收弹窗自动关闭。
4. 长期商家码应打开金额输入；固定金额码应显示原金额。核对完整收款地址、代币和费用；此时不应自动弹钱包或显示 Paid。
5. 客户复核并显式确认钱包后，授权码旁选择 **Send to nearby phone**。
6. 商家关闭原发送弹窗，在原收款请求内选择 **Read nearby phone**，读取客户授权。复核后点击商家费用确认，在钱包补签；原 M3 流程广播并查链。
7. M4 在 **Pay with demo stock** 区域用相同 Send/Read 按钮，依次传递商家请求 → 客户签名 → 商家签名 → 流动性钱包签名。所有人仍逐次确认钱包，近期 blockhash 过期后必须查状态再重新开始。

异常路径：发送中离开 App/锁屏/停止、等待超过一分钟、碰传中移开手机、接收端取消、两端同时选发送、关闭 NFC、不支持 HCE、收到错误付款或篡改数据。应拒绝/取消并保留已有未决付款，不能扣款、丢签名或显示 Paid。

## 已知限制与下一步

- 需要双方主动打开 App 选择发送/读取；不支持客户 App 关闭时由另一台手机自动唤起。
- 真机射频、不同品牌 NFC 天线位置、系统 HCE 策略和实际钱包兼容性尚未验证。请按以上步骤验收。
- 单次发送会话一分钟内可被多次读取，直到停止/离开前台/超时；长期商家码本身仍长期有效。
- 传输成功不会自动表示“已支付”，也不会自动开启新的签名操作。
- 下一阶段仍为 M2 通用红包；先审查拼手气随机分配方案。本轮未扩大到红包、蓝牙、后台支付或服务器。
