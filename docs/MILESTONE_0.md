# Milestone 0 · 2026-10-03

目标：Android 应用连接钱包，显示 Devnet SOL/USDC，A 钱包通过用户签名向 B 转账 1 USDC。

## 已实现

- npm workspace + Android Expo 项目；依赖版本由 lockfile 固定。
- MWA 连接/撤销授权；授权账户变化时阻止继续付款。远程撤销失败仍清除本地会话，允许重新连接。
- Devnet RPC genesis 校验；资产配置集中管理 mint、symbol、decimals、tokenProgram、display；本阶段仅启用 USDC。
- 资产参数驱动的 ATA 余额、转账、整数金额、签名与链上核验。未支持的显示扩展必须明确拒绝，不擅自套用普通小数格式。
- 待确认记录保存资产身份并验证白名单，兼容旧版仅 USDC 的记录。
- 本轮未创建 AAPLx-DEMO，也未实现 Token-2022 / Scaled UI Amount；这些属于 Milestone 1。
- 复核页面 → 钱包签名 → 校验返回的交易内容和签名 → 保存待确认信息 → 广播。
- 签名请求使用 MWA `signTransactions`；应用不代签。签名交易的 message 必须与原始构造内容完全相同。
- 链上确认并核验转账内容后显示 Paid；待确认交易持久化、轮询恢复、防止盲目重试。

- 独立签名边界测试：验证钱包未篡改 message、签名有效、只返回一笔交易，且保存成功后才广播。
- 查询结果按签名绑定；较晚返回的待确认结果不能覆盖已确认结果。
- Android 自动备份关闭，移除无关文件权限；新增 `npm run apk:android`，并补齐浅色主题原生模块。

- RPC 请求含响应正文设置 15 秒上限，429 不隐式重试；广播超时继续保留原签名。
- 签名前核对付款和收款 ATA 身份、初始化和冻结状态；现有收款 ATA 只需网络费。

## 验证记录

| 检查 | 状态 |
| --- | --- |
| TypeScript | 已通过 |
| 37 个自动化测试 | 已通过；模拟 RPC，非真机交易 |
| Android JS/Hermes 导出 | 已通过；存在上游 noble 导出警告 |
| Expo 依赖匹配 | 已通过本地 SDK 55 依赖映射检查 |
| Android 原生构建 | 已通过：arm64-v8a release 测试 APK，含 Hermes bundle |
| APK 签名 / 权限校验 | 已通过 apksigner v2；无录音、悬浮窗或外部文件读写权限 |
| APK 安装 / 首页渲染 | Devnet hash 修复版已安装；本轮恢复流程新版仅完成构建，待用户安装验收 |
| Fake Wallet / MWA 授权及余额加载 | 用户已确认余额正常（2026-10-03）；转账未验证 |
| A → B 1 Devnet USDC | 待验证；尚无真实交易签名 |
| 断网 / 杀进程后恢复 | 代码已实现，待设备验收 |

不要在真实验收前将此里程碑标记为完成，也不要进入下一里程碑。

## 依赖审计

本轮 `npm audit` 返回 20 项传递依赖告警（13 moderate / 7 high）。计数包含上游依赖传播，不等于 20 个独立漏洞。

- `node-forge`：Expo CLI / 开发证书依赖，RSA 签名校验告警。
- `bigint-buffer`：SPL SDK 依赖的 Node 原生转换实现存在 buffer overflow 告警；移动端使用浏览器实现，但不能据此把整个依赖链标记为已修复。
- `uuid`、`stream-json`：经 Expo/Xcode 工具及 web3.js/Jayson 引入。
- 审计给出的部分修复目标是 Expo 44 或 SPL Token 0.1.8，会破坏当前 SDK/API，不做 `npm audit fix --force`。

保留锁文件、继续 Devnet 限定。正式发布前需要重新评估上游修复与替代版本，并重做构建和真机验收。

## 真实验收记录（待填）

- Android 设备/系统：
- 钱包名称/版本：
- A/B 公开地址：
- Devnet Explorer 交易链接：
- A/B 转账前后 USDC 余额：
- 拒绝签名、断网恢复、重复点击结果：

仅记录公开信息；不要记录私钥、助记词或授权令牌。

## 下一步

完成上述真机验收。按照最新 HACKATHON_SCOPE.md，通过后才开始 Milestone 1：AAPLx-DEMO / Token-2022 / Scaled UI Amount；不自动开始。

## 本轮设备验证记录

- 首次安装遇到 API 37 模拟器系统级 DeadSystemException / System UI ANR。
- 重试非流式安装成功，Activity 冷启动返回 Status: ok，首页通过 UI 层级和截图确认已渲染。
- 当时未安装 Fake Wallet，没有完成钱包连接及链上转账。
- 用户要求后续只写代码，因此已关闭由本轮启动的模拟器，停止设备操作。
- [首页截图（资产抽象调整前）](screenshots/m0-home.png)。

## Milestone 0 历史 APK

当前输出路径已由后续 Milestone 1 构建覆盖；最新安装包与验收状态见 [Milestone 1](MILESTONE_1.md)。以下 SHA 为当时的历史构建记录。

路径：`apps/mobile/android/app/build/outputs/apk/release/app-release.apk`。

SHA-256：`8ad88ff8e2a262e9a0dba9fd49a5b95fd50e2cd94f50db27a9d5245e3ee3d480`。

这是包含 RPC 超时、token account 校验及 Devnet genesis hash 修复的内部测试安装包，使用本地测试签名；不是正式商店发布版本。最新源码已通过类型检查、37 个测试和 APK 编译。

2026-10-03：用户截图报告 `RPC is not Solana Devnet`。官方 Devnet RPC 的 `getGenesisHash` 返回完整值 `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`；原配置被截短，导致误拦截。已修正配置，并让测试使用独立的 RPC 返回值样本，覆盖完整值通过、截短值和其他网络拒绝。按用户新指令，已通过 `adb -s emulator-5554 install --no-streaming -r` 覆盖安装，返回 `Success`，保留应用数据。钱包余额和真实转账由用户继续验收。


## 付款恢复补齐（2026-10-03）

- 本地恢复失败时提供 Retry recovery；成功读回记录前，连接/发送保持禁用，不清除原记录。
- 空字符串不再作为“没有待确认交易”；只有存储键不存在才允许正常开始付款。
- 恢复待确认交易后立即查链；回到前台立即触发检查，同一个观察器不会产生并行查询或多个轮询计时器。
- RPC 查询失败展示保留付款记录的提示，并继续每 5 秒重试；终态停止自动查询，卸载后忽略迟到响应。
- 本轮 APK 已重新构建，尚未覆盖安装；上面的安装记录指上一版。

验证命令（项目根目录）：

```sh
npm run typecheck
npm test
~/Library/Android/sdk/platform-tools/adb install --no-streaming -r apps/mobile/android/app/build/outputs/apk/release/app-release.apk
```

设备步骤：连接 Devnet 钱包 A，向 B 发送 1 USDC 并在钱包确认；显示待确认时切到后台再返回，观察同一笔交易的状态更新。断网时应保留付款并显示查询失败提示，恢复网络后继续查询。已支付后用交易详情核对 B 收款。不要清空 App 数据来重试付款。

本地存储故障的 Retry recovery 入口仍待设备故障场景验证；自动化测试不代表真实转账已验收。
