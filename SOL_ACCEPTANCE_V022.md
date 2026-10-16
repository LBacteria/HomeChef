> 发布收尾：用户于 2026-10-16 验收通过并授权以 v0.2.2 提交、推送。下文“未提交/未推送/版本号未改”为夜间验收时点的历史状态，当前版本及提交以 Git 和 CHANGELOG 为准。

# HomeChef v0.2.2 · Sol 最终独立验收

日期：2026-10-16（UTC+8）。实际约00:14开始，原定23:59已过，直接执行，没有创建定时任务。DSH通过已配对的本机接口实际完成三轮开发/修复，Sol检查实际源码、独立运行测试并做浏览器验证。本文是最终验收结论；开发过程详见 HANDOFF_V022.md。

## A. 完成情况

已完成可运行的本地整餐推荐MVP：主页“开始烹饪”→选择1–12人→最多5套整餐→每道菜配料/步骤和整餐合并需求→缺口/理由→确认→既有烹饪会话→结算。保留中式灶台主页、手选菜谱、记录管理、既有烹饪与结算。

推荐只读；跨菜及菜内重复配料先合并；单位不兼容和未知数量明确提示；过期库存不计入推荐。已补方案确认时的数据快照检查、原子创建整餐会话、短期请求去重、请求失败/加载/空状态。默认过期库存排除同时应用于结算预览和实际扣减。

部分实现/有界能力：菜谱缺基准人数，采用全局“两人份”假设，而非每张菜谱独立维护人数；搭配以分类/标签和组合重叠软评分，未提供营养或主菜/汤/主食的强制角色模型；幂等为进程内有界缓存。

未实施（范围外）：AI接入、采购清单、真实库迁移、正式服务启动、commit/push/tag/发布、版本号或CHANGELOG修改。

## B. 算法与自主决定

- 每道菜倍率=人数÷2，推荐和最终会话一致。1人默认2道菜，2–12人默认3道；菜谱少时降为简餐。
- 先按单菜库存匹配度筛候选，再取最多40张；最多枚举20000种不重复组合。通常返回3–5套，组合不足照实返回。
- 排序先比较等级（确定够用→待核对→缺料），再比较分数；同级候选采用重叠惩罚60，尽量少重复菜品，固定签名打破平局，结果可复现。
- 分数=真正全足奖励1000 + 满足比例×100 + 临期食材项数×6 + 分类/标签多样性×8 − 主料缺口项数×40 − 缺调味品项数×10 − 未知用量项数×8。
- 同definition_id、同单位先合并整餐需求，再比可用库存；不做单位换算。缺少数量直接给出；未知数量不伪装成全足。调味品只判断有无。
- 临期沿用现有设置；推荐始终排除过期，今天到期仍可用。结算遵守allow_expired_for_recipe，默认排除过期，显式开启才计入；预览和扣减一致。
- 参数集中于server/src/services/recommendationConfig.ts。候选截断、两人份假设与轻量搭配规则可能错过更适合用户的组合，建议醒后先用熟悉菜谱检查份量。
- 幂等缓存10分钟、200条；同键同内容返回同会话，同键异内容409。重启、缓存淘汰、多实例不保证去重；前端不自动重试，结果不明先查烹饪记录。

## C. 文件变更

新增：

| 文件 | 用途 |
|---|---|
| server/src/services/recommendationConfig.ts | 集中参数与上限 |
| server/src/services/recommendationAlgorithm.ts | 合并需求、匹配、评分与组合 |
| server/src/services/recommendationService.ts | 查询编排、每菜详情、稳定排序、快照 |
| server/src/routes/recommendation.ts | 推荐与确认API、校验和短期幂等 |
| server/verify-v022-recommendation.ts | 127项推荐/集成/结算验证 |
| server/seed/seed-v022-demo.ts | 全新隔离演示库，拒绝已有文件和受保护路径 |
| client/src/api/recommendation.ts | 前端请求契约 |
| client/src/pages/RecommendPage.tsx | 人数、候选、详情、确认及错误恢复 |
| client/src/recommend.css | 推荐页面样式与窄屏适配 |
| HANDOFF_V022.md | DSH开发交接、接口和设计说明 |
| SOL_ACCEPTANCE_V022.md | 本独立验收报告 |

修改：

| 文件 | 用途 |
|---|---|
| client/src/App.tsx | 新视图与指定会话衔接 |
| client/src/pages/HomePage.tsx | 中央按钮进入推荐 |
| client/src/components/MoreToolsPanel.tsx | 保留手动烹饪入口 |
| client/src/pages/CookingPage.tsx | 直达会话，修复StrictMode初始化请求被丢弃 |
| client/src/types/api.ts | 推荐与确认类型 |
| client/src/main.tsx | 引入样式 |
| server/src/server.ts | 注册路由 |
| server/src/routes/http.ts | 新错误码映射 |
| server/src/services/errors.ts | 快照/请求冲突错误 |
| server/src/services/cookingService.ts | 事务内一次创建会话及全部菜品 |
| server/src/services/settlementService.ts | 预览和扣减的过期过滤一致 |
| server/verify-v012-settings-expiry.ts | 旧测试以本地今天构造日期，保留全部断言 |

没有新增schema或迁移。

## D. Sol实际执行与结果

以下命令均为真实执行。数据库测试在唯一临时目录/临时数据库；旧测试统一设置HOME_CHEF_TEST_DB_DIR为本轮独立临时目录。测试工作目录为D:\HomeChef\server，构建工作目录为D:\HomeChef。

| 命令 | 结果 |
|---|---|
| npm run build | client tsc+Vite（68模块）与server tsc，exit0 |
| npm run build --workspace client | 最后界面恢复修复后再次通过，exit0 |
| npx tsx verify-v022-recommendation.ts | 127通过/0失败；最终文案整理后复测仍127/0 |
| npx tsx verify-v0211-cooking-records.ts | 65/0 |
| npx tsx verify-recipe-batch1.ts | 83/0 |
| npx tsx verify-recipe-batch2.ts | 103/0 |
| npx tsx verify-recipe-batch3.ts | 106/0（含原烹饪/结算回归） |
| npx tsx verify-v012-settings-expiry.ts | 68/0 |
| node --import file:///D:/HomeChef/node_modules/tsx/dist/loader.mjs <mirror>/dsh-experiment/independent-v022.ts | 独立纯算法11/0 |
| node <mirror>/dsh-experiment/independent-api-v022.cjs | 独立HTTP9/0 |
| node <mirror>/dsh-experiment/verify-real-data.cjs | 真实库20表摘要全部与开工一致 |
| git -C D:\HomeChef diff --check | exit0；仅Git的LF/CRLF提示，无空白错误 |

mirror=C:\Users\guoqi\.codex\.chatgpt-projects\g-p-6ace4cdc0754819184e11c76c67d17c8。
完整五组回归日志在mirror/dsh-experiment/final-logs/，独立HTTP结果在independent-api-v022-result.json。DSH提供的浏览器结果没有被当作Sol独立证据。

真实失败及修复：独立纯算法最初9通过/2失败（混合未知用量、调味品比例），修复后11/0；独立HTTP最初8/1（过期100+新鲜20被预览成120），修复后9/0；旧日期测试在北京时间午夜UTC跨日失败，Sol修正测试日期锚点，全部原断言68/0。没有删除或弱化失败断言。

Sol浏览器验证：用自建样例库和64211/64212隔离服务，四人→3菜→展开每菜配料→核对→进入会话→逐菜完成→预览→结算成功。最终样例数量番茄18→14、土豆20→16、胡萝卜20→16，其他两项仍20。真实库未用于该操作。中途人为只改样例库存，旧快照409且确认禁用；点击重新生成真正获取新库存，之后可正常完成流程。360px视口无水平溢出（文档345px、内容321px），检查后已恢复默认视口。

界面恢复按钮最初仅返回缓存列表；Sol最后修成清除旧方案并重新请求，已在浏览器实测。界面文案去掉原始Markdown符号和绝对的重试保证。

截图：mirror/dsh-experiment/v022-final-review.png、v022-final-settled.png（均为隔离样例）。

演示脚本额外验证：新临时库生成成功（7定义、6菜谱、7库存、0会话），再用同一路径执行被拒绝exit1；不覆盖已有文件。日期基于本地日历，复用项目保护函数拒绝真实库及侧文件。

## E. 醒后可调整的产品默认值

请优先体验：全局两人份是否符合现有菜谱；1人2菜/多人3菜是否合适；未知用量和调味品的核对提示；方案重叠与临期偏好。当前都是可调默认值，不阻塞本轮交付。

## F. Git与数据

分支main，HEAD 61722f6d9ad3774cf7dcd969d7dbdd4c9352b865，开工工作区干净。交付为12个已跟踪修改、11个未跟踪新增文件（含两份报告），未暂存、未commit、未push、未tag，版本和CHANGELOG未改。上表列出全部变更。

真实库只读逐表比对共20表，表名集合、行数、内容哈希全部未变。没有真实迁移、seed、删除、改名、新建会话或结算测试。没有修改DSH安装/全局设置或系统配置。

## G. 安全体验和下一步

正式3002/5173在最终检查时均没有监听；本轮没有为用户启动真实数据库服务。隔离预览验收后已停止，不声称后台仍在开发。无需先提交、拉取或执行数据库迁移即可体验本地代码。

确认3002和5173空闲后，在两个PowerShell窗口分别运行：

```powershell
# 窗口1：后端，使用现有真实数据，不做迁移
cd D:\HomeChef\server
$env:PORT = '3002'
$env:HOME_CHEF_DB_PATH = 'D:\HomeChef\server\data\homechef.db'
npx tsx src/server.ts
```

```powershell
# 窗口2：前端
cd D:\HomeChef\client
$env:HOME_CHEF_API_TARGET = 'http://127.0.0.1:3002'
npm run dev -- --host 127.0.0.1 --port 5173 --strictPort
```

打开http://127.0.0.1:5173/。不需要HOME_CHEF_ALLOW_REAL_DB，不运行迁移或演示seed；端口占用时先查归属，不杀未知进程。不要同时另开一套启动器造成重复后端。

次日先人工检查真实菜谱的份量是否合适和中文界面，再决定调参数或提交代码。发布、提交、推送由用户后续决定。
