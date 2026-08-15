/**
 * dsh-wechat-bot client 半区:
 * 设置 → 独立一栏「微信机器人」设置页面 (settings.section, id: wechat-bot),
 * 页面内嵌扫码登录 + 运行状态 (不再单独开状态页, 不再有左下角按钮)。
 */
window.__ModuleLoader__.load({
	id: "dsh-wechat-bot",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");

		/** 字典 (跟随 DSH 语言)。 */
		const NS = "wechat-bot";
		const zh = {
			"settings.title": "微信机器人",
			"settings.desc": "扫码登录、运行状态与会话配置",
			"settings.status": "运行状态",
			"settings.login": "获取二维码",
			"settings.scanHint": "使用微信扫一扫, 创建/绑定 Bot 助手 (8 分钟内有效)",
			"settings.scanned": "已扫码, 请在手机上确认…",
			"settings.loggedIn": "已登录",
			"settings.notLoggedIn": "未登录",
			"settings.error": "错误",
			"settings.refresh": "刷新状态",
			"settings.autoReply": "自动回复模板 ({content}/{from})",
			"settings.bridge": "启用会话桥接 (微信消息自动送入 DSH 会话并回复)",
			"settings.workspace": "默认工作区 (绝对路径)",
			"settings.defaultWorkspace": "未绑定 chat 的兜底工作区",
			"settings.bindings": "绑定列表 (JSON: [{chatId, workspace?|sessionId?}])",
			"settings.bindChat": "绑定微信会话:",
			"settings.currentBind": "当前绑定",
			"settings.chooseWorkspace": "选择工作区",
			"settings.chooseSession": "选择会话",
			"settings.bindNow": "绑定",
			"settings.bindHint": "未绑定的微信消息不会处理; 绑定后微信消息将进入所选会话",
			"settings.modeExisting": "选择原有会话",
			"settings.modeNew": "新建会话",
			"settings.newSessionName": "新会话名称",
			"settings.newSessionNamePlaceholder": "例如: 微信助手",
			"settings.newHint": "首次收到微信消息时创建会话并命名为该名称",
			"settings.save": "保存",
			"settings.saved": "已保存 ✓",
			"settings.saving": "保存中…",
			"settings.placeholder.workspace": "例如 D:\\proj 或 C:\\work",
			"settings.placeholder.bindings": '[{"chatId":"o9cq...","workspace":"D:\\\\proj"}]',
			"settings.hint": "保存后实时生效, 无需重启",
		};
		const en = {
			"settings.title": "WeChat Bot",
			"settings.desc": "QR login, status and session config",
			"settings.status": "Status",
			"settings.login": "Get QR code",
			"settings.scanHint": "Scan with WeChat to create/bind the Bot assistant (valid 8 min)",
			"settings.scanned": "Scanned, confirm on your phone…",
			"settings.loggedIn": "Logged in",
			"settings.notLoggedIn": "Not logged in",
			"settings.error": "Error",
			"settings.refresh": "Refresh",
			"settings.autoReply": "Auto-reply template ({content}/{from})",
			"settings.bridge": "Enable session bridge (messages feed into DSH sessions)",
			"settings.workspace": "Default workspace (absolute path)",
			"settings.defaultWorkspace": "Fallback workspace for unbound chats",
			"settings.bindings": "Bindings (JSON: [{chatId, workspace?|sessionId?}])",
			"settings.bindChat": "Bind WeChat chat:",
			"settings.currentBind": "Current binding",
			"settings.chooseWorkspace": "Choose workspace",
			"settings.chooseSession": "Choose session",
			"settings.bindNow": "Bind",
			"settings.bindHint": "Unbound chats are ignored; after binding, WeChat messages flow into the chosen session",
			"settings.modeExisting": "Choose existing session",
			"settings.modeNew": "New session",
			"settings.newSessionName": "New session name",
			"settings.newSessionNamePlaceholder": "e.g. WeChat Assistant",
			"settings.newHint": "The session is created and named on first WeChat message",
			"settings.save": "Save",
			"settings.saved": "Saved ✓",
			"settings.saving": "Saving…",
			"settings.placeholder.workspace": "e.g. D:\\proj or C:\\work",
			"settings.placeholder.bindings": '[{"chatId":"o9cq...","workspace":"D:\\\\proj"}]',
			"settings.hint": "Saved changes apply immediately",
		};

		/** 需要的服务。 */
		const inject = ["slots", "locale", "settingsScope"];

		/** 页面样式。 */
		const pageStyle = {
			section: { display: "flex", flexDirection: "column", gap: "14px", padding: "4px 2px" },
			title: { fontSize: "16px", fontWeight: 600, margin: "0" },
			intro: { fontSize: "13px", color: "var(--dsw-alias-label-tertiary, #888)", margin: "0" },
			card: { border: "1px solid var(--dsw-alias-border-l2, #e5e6eb)", borderRadius: "12px", background: "var(--dsw-alias-bg-layer-3, #fff)", padding: "14px 16px", display: "flex", flexDirection: "column", gap: "10px" },
			row: { display: "flex", flexDirection: "column", gap: "4px" },
			label: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary, #888)" },
			input: { padding: "8px 10px", borderRadius: "8px", border: "1px solid var(--dsw-alias-border-l2, #d0d5dd)", background: "var(--dsw-alias-bg-module-platform, #fff)", color: "inherit", fontSize: "13px", fontFamily: "inherit" },
			check: { display: "flex", alignItems: "center", gap: "8px", fontSize: "13px" },
			actions: { display: "flex", alignItems: "center", gap: "12px", marginTop: "4px" },
			button: { padding: "8px 16px", borderRadius: "8px", border: "none", background: "#07c160", color: "#fff", cursor: "pointer", fontSize: "13px" },
			buttonDisabled: { padding: "8px 16px", borderRadius: "8px", border: "none", background: "#9ca3af", color: "#fff", cursor: "default", fontSize: "13px" },
			buttonSecondary: { padding: "8px 16px", borderRadius: "8px", border: "1px solid var(--dsw-alias-border-l2, #d0d5dd)", background: "transparent", color: "inherit", cursor: "pointer", fontSize: "13px" },
			status: { fontSize: "12px", color: "var(--dsw-alias-label-tertiary, #888)" },
			badge: { display: "inline-flex", alignItems: "center", gap: "6px", padding: "3px 10px", borderRadius: "999px", fontSize: "12px", fontWeight: 600 },
			badgeOk: { background: "#dcfce7", color: "#166534" },
			badgeWarn: { background: "#fef3c7", color: "#92400e" },
			badgeErr: { background: "#fee2e2", color: "#b91c1c" },
			qrcode: { display: "flex", justifyContent: "center", padding: "8px 0" },
			qrcodeImg: { width: "220px", height: "220px", borderRadius: "8px", border: "1px solid var(--dsw-alias-border-l2, #e5e6eb)" },
			errorText: { fontSize: "12px", color: "#b91c1c", wordBreak: "break-all" },
			user: { fontSize: "13px", fontWeight: 600 },
			statusRow: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" },
		};

		/** 状态文案映射。 */
		const STATUS_TEXT = {
			idle: (t) => t("settings.notLoggedIn"),
			starting: () => "…",
			"waiting-scan": (t) => t("settings.scanHint"),
			scanned: (t) => t("settings.scanned"),
			"logged-in": (t) => t("settings.loggedIn"),
			error: (t) => t("settings.error"),
		};

		/**
		 * 扫码登录 + 运行状态内嵌组件: 轮询 /wechat/status/json。
		 */
		function WechatStatusPanel({ t }) {
			const [state, setState] = react.useState({ status: "idle", qrcode: null, error: null, user: null });
			const [busy, setBusy] = react.useState(false);
			const refresh = react.useCallback(() => {
				fetch("/wechat/status/json", { headers: { accept: "application/json" } })
					.then((r) => (r.ok ? r.json() : null))
					.then((data) => {
						if (data) setState({ status: data.status, qrcode: data.qrcode, error: data.error, user: data.user });
					})
					.catch(() => {});
			}, []);
			react.useEffect(() => {
				refresh();
				const timer = setInterval(refresh, 3000);
				return () => clearInterval(timer);
			}, [refresh]);
			const requestQr = () => {
				setBusy(true);
				fetch("/wechat/status/login", { method: "POST" })
					.then((r) => r.json())
					.then(() => refresh())
					.finally(() => setBusy(false));
			};
			const badgeClass = state.status === "logged-in" ? pageStyle.badgeOk : state.status === "error" ? pageStyle.badgeErr : pageStyle.badgeWarn;
			return react_jsx_runtime.jsxs("div", {
				style: pageStyle.card,
				children: [
					react_jsx_runtime.jsxs("div", {
						style: pageStyle.statusRow,
						children: [
							react_jsx_runtime.jsx("span", {
								style: Object.assign({}, pageStyle.badge, badgeClass),
								children: (STATUS_TEXT[state.status] ?? (() => state.status))(t),
							}),
							state.user ? react_jsx_runtime.jsx("span", { style: pageStyle.user, children: state.user }) : null,
						]
					}),
					state.status === "waiting-scan" && state.qrcode
						? react_jsx_runtime.jsx("div", {
							style: pageStyle.qrcode,
							children: react_jsx_runtime.jsx("img", { src: state.qrcode, alt: "微信扫码登录", style: pageStyle.qrcodeImg }),
						})
						: null,
					state.error ? react_jsx_runtime.jsx("div", { style: pageStyle.errorText, children: state.error }) : null,
					react_jsx_runtime.jsx("div", {
						style: pageStyle.actions,
						children: [
							react_jsx_runtime.jsx("button", {
								type: "button",
								style: busy ? pageStyle.buttonDisabled : pageStyle.button,
								disabled: busy,
								onClick: requestQr,
								children: t("settings.login"),
							}),
							react_jsx_runtime.jsx("button", {
								type: "button",
								style: pageStyle.buttonSecondary,
								onClick: refresh,
								children: t("settings.refresh"),
							}),
						]
					}),
				]
			});
		}

		/**
		 * 绑定会话选择器: 列出工作区及其会话, 用户选择后绑定微信 chat。
		 * props: { t, chatId, currentBinding, onBound }
		 */
		function WechatBindingPicker({ t, chatId, currentBinding, onBound, liveBindings }) {
			const [workspaces, setWorkspaces] = react.useState([]);
			const [selWs, setSelWs] = react.useState("");
			const [selSid, setSelSid] = react.useState("");
			const [mode, setMode] = react.useState("existing"); // "existing" | "new"
			const [newTitle, setNewTitle] = react.useState("");
			const [busy, setBusy] = react.useState(false);
			const [msg, setMsg] = react.useState(null);
			const [chatIdState, setChatIdState] = react.useState(chatId ?? "");
			const [bindings, setBindings] = react.useState(liveBindings ?? []);
			const refresh = () => {
				fetch("/wechat/status/workspaces", { headers: { accept: "application/json" } })
					.then((r) => (r.ok ? r.json() : null))
					.then((data) => {
						if (data && data.ok) setWorkspaces(data.workspaces ?? []);
					})
					.catch(() => {});
				// 从状态接口取 chatId + 当前生效的 bindings
				fetch("/wechat/status/json", { headers: { accept: "application/json" } })
					.then((r) => (r.ok ? r.json() : null))
					.then((data) => {
						const cid = data?.diag?.lastBridge?.chatId || data?.user;
						if (cid) setChatIdState(cid);
						if (Array.isArray(data?.bindings)) setBindings(data.bindings);
					})
					.catch(() => {});
			};
			react.useEffect(() => {
				refresh();
				// 定时轮询: 新建会话后自动出现在列表
				const timer = setInterval(refresh, 5000);
				return () => clearInterval(timer);
			}, []);
			const sessionsOf = (ws) => ws.sessions ?? [];
			const onBind = () => {
				const cid = chatIdState.trim();
				if (!cid) { setMsg({ ok: false, text: "chatId 为空: 请先在微信给机器人发一条消息, 或手动输入" }); return; }
				if (!selWs) { setMsg({ ok: false, text: "请选择工作区" }); return; }
				if (mode === "existing" && !selSid) { setMsg({ ok: false, text: "请选择要绑定的会话" }); return; }
				if (mode === "new" && !newTitle.trim()) { setMsg({ ok: false, text: "请输入新会话名称" }); return; }
				setBusy(true);
				const selWsObj2 = workspaces.find((w) => String(w.id) === selWs || w.path === selWs);
				const payload = { chatId: cid, workspace: selWsObj2?.path ?? "" };
				if (mode === "existing") {
					// 选择原有会话: 用 工作区路径 + 会话标题 绑定 (动态解析, 会话 id 变了也能找到)
					const selSession = sessionsOf(selWsObj2 ?? {}).find((s) => s.id === selSid);
					payload.sessionTitle = selSession?.title ?? "";
				} else {
					// 新建会话: 绑定 工作区 + 自定义会话名 (首次消息到达时创建并命名)
					payload.sessionTitle = newTitle.trim();
				}
				fetch("/wechat/status/bind", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(payload),
				})
					.then((r) => r.json())
					.then((d) => {
						setMsg(d.ok ? { ok: true, text: "✓ 已绑定" } : { ok: false, text: d.message ?? "绑定失败" });
						if (d.ok) {
							if (Array.isArray(d.bindings)) setBindings(d.bindings);
							onBound?.();
							setTimeout(refresh, 1200);
						}
					})
					.catch(() => setMsg({ ok: false, text: "绑定失败" }))
					.finally(() => setBusy(false));
			};
			const selWsObj = workspaces.find((w) => String(w.id) === selWs || w.path === selWs);
			const liveBinding = bindings.find((b) => b.chatId === chatIdState);
			const bindText = liveBinding
				? (liveBinding.sessionId
					? `会话 ${liveBinding.sessionId}`
					: liveBinding.sessionTitle
						? `工作区 ${liveBinding.workspace} / 会话「${liveBinding.sessionTitle}」`
						: `工作区 ${liveBinding.workspace} (新建会话)`)
				: "未绑定";
			const modeBtn = (value, label) => react_jsx_runtime.jsx("label", {
				style: { display: "inline-flex", alignItems: "center", gap: "6px", fontSize: "13px", cursor: "pointer", padding: "6px 12px", borderRadius: "8px", border: mode === value ? "1px solid #07c160" : "1px solid var(--dsw-alias-border-l2, #d0d5dd)", background: mode === value ? "rgba(7,193,96,.08)" : "transparent" },
				children: [
					react_jsx_runtime.jsx("input", { type: "radio", name: "bind-mode", checked: mode === value, onChange: () => setMode(value), style: { accentColor: "#07c160" } }),
					label,
				]
			});
			return react_jsx_runtime.jsxs("div", {
				style: pageStyle.card,
				children: [
					react_jsx_runtime.jsx("div", {
						style: pageStyle.row,
						children: [
							react_jsx_runtime.jsx("label", {
								style: pageStyle.row,
								children: [
									react_jsx_runtime.jsx("span", { style: pageStyle.label, children: t("settings.bindChat") }),
									react_jsx_runtime.jsx("input", {
										style: pageStyle.input,
										value: chatIdState,
										onChange: (e) => setChatIdState(e.target.value),
										placeholder: "微信 chat_id (发消息后自动识别)",
									}),
								]
							}),
							react_jsx_runtime.jsx("span", { style: pageStyle.status, children: t("settings.currentBind") + ": " + bindText }),
						]
					}),
					react_jsx_runtime.jsx("span", { style: pageStyle.status, children: t("settings.bindHint") }),
					react_jsx_runtime.jsxs("div", {
						style: { display: "flex", gap: "8px", flexWrap: "wrap" },
						children: [
							modeBtn("existing", t("settings.modeExisting")),
							modeBtn("new", t("settings.modeNew")),
						]
					}),
					react_jsx_runtime.jsx("label", {
						style: pageStyle.row,
						children: [
							react_jsx_runtime.jsx("span", { style: pageStyle.label, children: t("settings.chooseWorkspace") }),
							react_jsx_runtime.jsx("select", {
								style: pageStyle.input,
								value: selWs,
								onChange: (e) => { setSelWs(e.target.value); setSelSid(""); },
								children: [
									react_jsx_runtime.jsx("option", { value: "", children: t("settings.chooseWorkspace") + "…" }),
									...workspaces.map((w) => react_jsx_runtime.jsx("option", { value: String(w.id), children: `${w.title || w.path} (${w.path})` })),
								]
							}),
						]
					}),
					mode === "existing" && selWsObj ? react_jsx_runtime.jsx("label", {
						style: pageStyle.row,
						children: [
							react_jsx_runtime.jsx("span", { style: pageStyle.label, children: t("settings.chooseSession") }),
							react_jsx_runtime.jsx("select", {
								style: pageStyle.input,
								value: selSid,
								onChange: (e) => setSelSid(e.target.value),
								children: [
									react_jsx_runtime.jsx("option", { value: "", children: t("settings.chooseSession") + "…" }),
									...sessionsOf(selWsObj).map((s) => react_jsx_runtime.jsx("option", { value: s.id, children: `${s.title || s.id} ${s.cwd ? "· " + s.cwd : ""}` })),
								]
							}),
						]
					}) : null,
					mode === "new" ? react_jsx_runtime.jsx("label", {
						style: pageStyle.row,
						children: [
							react_jsx_runtime.jsx("span", { style: pageStyle.label, children: t("settings.newSessionName") }),
							react_jsx_runtime.jsx("input", {
								style: pageStyle.input,
								value: newTitle,
								onChange: (e) => setNewTitle(e.target.value),
								placeholder: t("settings.newSessionNamePlaceholder"),
							}),
							react_jsx_runtime.jsx("span", { style: pageStyle.status, children: t("settings.newHint") }),
						]
					}) : null,
					react_jsx_runtime.jsxs("div", {
						style: pageStyle.actions,
						children: [
							react_jsx_runtime.jsx("button", {
								type: "button",
								style: busy ? pageStyle.buttonDisabled : pageStyle.button,
								disabled: busy,
								onClick: onBind,
								children: t("settings.bindNow"),
							}),
							react_jsx_runtime.jsx("button", { type: "button", style: pageStyle.buttonSecondary, onClick: refresh, children: t("settings.refresh") }),
							msg ? react_jsx_runtime.jsx("span", { style: msg.ok ? pageStyle.status : pageStyle.errorText, children: msg.text }) : null,
						]
					}),
				]
			});
		}

		/**
		 * 独立设置页面: 微信机器人配置 (含扫码登录状态区)。
		 * props: { t, value, save, saving, close }
		 */
		function WechatSettingsPage({ t, value, save, saving }) {
			const [draft, setDraft] = react.useState(null);
			const [savedFlash, setSavedFlash] = react.useState(false);
			const current = draft ?? value ?? {};
			const setField = (key) => (event) => {
				const next = { ...current, [key]: event.target.type === "checkbox" ? event.target.checked : event.target.value };
				setDraft(next);
			};
			const setBindings = (event) => {
				let parsed = current.bindings ?? [];
				try {
					parsed = JSON.parse(event.target.value || "[]");
					if (!Array.isArray(parsed)) throw new Error("not array");
				} catch {
					return; // 非法 JSON: 保持原值
				}
				setDraft({ ...current, bindings: parsed });
			};
			const onSave = async () => {
				const next = draft ?? current;
				await save(next);
				setDraft(null);
				setSavedFlash(true);
				setTimeout(() => setSavedFlash(false), 1500);
			};
			return react_jsx_runtime.jsx("section", {
				style: pageStyle.section,
				children: [
					react_jsx_runtime.jsxs("div", {
						children: [
							react_jsx_runtime.jsx("h2", { style: pageStyle.title, children: t("settings.title") }),
							react_jsx_runtime.jsx("p", { style: pageStyle.intro, children: t("settings.desc") }),
						]
					}),
					react_jsx_runtime.jsx(WechatStatusPanel, { t }),
					react_jsx_runtime.jsx(WechatBindingPicker, {
						t,
						chatId: "",
						currentBinding: undefined,
						onBound: () => {},
						liveBindings: current.bindings,
					}),
					react_jsx_runtime.jsx("div", {
						style: pageStyle.card,
						children: [
							react_jsx_runtime.jsx("label", {
								style: pageStyle.check,
								children: [react_jsx_runtime.jsx("input", {
									type: "checkbox",
									checked: current.bridge !== false,
									onChange: setField("bridge"),
								}), t("settings.bridge")]
							}),
						]
					}),
					react_jsx_runtime.jsx("div", {
						style: pageStyle.card,
						children: [
							react_jsx_runtime.jsx("label", {
								style: pageStyle.row,
								children: [react_jsx_runtime.jsx("span", { style: pageStyle.label, children: t("settings.autoReply") }), react_jsx_runtime.jsx("input", {
									style: pageStyle.input,
									value: current.autoReply ?? "",
									onChange: setField("autoReply"),
									placeholder: "{content} / {from}",
								})]
							}),
							react_jsx_runtime.jsx("label", {
								style: pageStyle.row,
								children: [react_jsx_runtime.jsx("span", { style: pageStyle.label, children: t("settings.workspace") }), react_jsx_runtime.jsx("input", {
									style: pageStyle.input,
									value: current.workspace ?? "",
									onChange: setField("workspace"),
									placeholder: t("settings.placeholder.workspace"),
								})]
							}),
							react_jsx_runtime.jsx("label", {
								style: pageStyle.row,
								children: [react_jsx_runtime.jsx("span", { style: pageStyle.label, children: t("settings.defaultWorkspace") }), react_jsx_runtime.jsx("input", {
									style: pageStyle.input,
									value: current.defaultWorkspace ?? "",
									onChange: setField("defaultWorkspace"),
									placeholder: t("settings.placeholder.workspace"),
								})]
							}),
							react_jsx_runtime.jsx("label", {
								style: pageStyle.row,
								children: [react_jsx_runtime.jsx("span", { style: pageStyle.label, children: t("settings.bindings") }), react_jsx_runtime.jsx("textarea", {
									style: Object.assign({}, pageStyle.input, { minHeight: "96px", fontFamily: "monospace" }),
									value: JSON.stringify(current.bindings ?? [], null, 2),
									onChange: setBindings,
									placeholder: t("settings.placeholder.bindings"),
								})]
							}),
							react_jsx_runtime.jsxs("div", {
								style: pageStyle.actions,
								children: [
									react_jsx_runtime.jsx("button", {
										type: "button",
										style: saving ? pageStyle.buttonDisabled : pageStyle.button,
										disabled: saving,
										onClick: () => void onSave(),
										children: savedFlash ? t("settings.saved") : saving ? t("settings.saving") : t("settings.save"),
									}),
									react_jsx_runtime.jsx("span", { style: pageStyle.status, children: t("settings.hint") }),
								]
							}),
						]
					}),
				]
			});
		}

		/**
		 * 客户端插件入口: 注册独立设置页面 (内嵌扫码登录与状态)。
		 * @param ctx - client root context。
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "wechat-bot: dictionaries");

			ctx.effect(() => {
				const binder = ctx.get("webUiSettings") ?? ctx.settingsScope;
				const scope = binder.bind({ namespace: NS });
				const injectProps = () => {
					const snapshot = scope.getSnapshot();
					const value = snapshot.status === "ready" ? snapshot.value ?? {} : {};
					const saving = snapshot.status === "saving";
					const save = async (next) => {
						const keys = new Set([...Object.keys(value ?? {}), ...Object.keys(next)]);
						for (const key of keys) {
							const hasNext = Object.prototype.hasOwnProperty.call(next, key);
							const hasCur = Object.prototype.hasOwnProperty.call(value ?? {}, key);
							if (hasNext && !hasCur) {
								await scope.set(key, next[key]);
							} else if (hasNext && JSON.stringify(next[key]) !== JSON.stringify(value?.[key])) {
								await scope.set(key, next[key]);
							} else if (!hasNext && hasCur) {
								await scope.unset(key);
							}
						}
						await scope.load();
					};
					return { t: (key) => (zh[key] ?? en[key] ?? key), value, save, saving };
				};
				return ctx.slots.inject("settings.section", () => ctx.slots.register({
					name: "settings.section",
					id: "wechat-bot",
					order: 45,
					label: () => zh["settings.title"],
					locale: NS,
					inject: () => injectProps(),
				}, WechatSettingsPage));
			}, "wechat-bot: settings page");
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
