import React, { useCallback, useEffect, useState } from "react"
import type { AppInfo, CustomModel, ModelRef, ProviderConfigInput, ProvidersResponse, SkillInfo } from "@shared/types"
import { useCustomModels, saveCustomModels, loadCustomModels } from "./customModels"
import ariaTextImg from "@shared/img/aria-text.png"

interface Props {
  initialPage?: string
  providers: ProvidersResponse | null
  model: ModelRef | null
  directory: string | null
  onModelChange: (m: ModelRef) => void
  onRefreshProviders: () => Promise<void> | void
  onClose: () => void
}

type Status = { kind: "idle" } | { kind: "saving" } | { kind: "ok"; msg: string } | { kind: "error"; msg: string }
type Page = "general" | "models" | "providers" | "skills" | "server" | "conversations" | "about"

interface PageDef {
  id: Page
  label: string
  icon: React.ReactNode
}

const PAGES: PageDef[] = [
  {
    id: "general",
    label: "General",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21a8 8 0 0 1 16 0" />
      </svg>
    ),
  },
  {
    id: "conversations",
    label: "Conversations",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    ),
  },
  {
    id: "models",
    label: "Models",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="14" width="20" height="14" rx="2" />
        <path d="M8 21h8M12 17v4" />
      </svg>
    ),
  },
  {
    id: "providers",
    label: "Providers",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 2v6M15 2v6M7 8h10v3a5 5 0 0 1-10 0zM12 16v6" />
      </svg>
    ),
  },
  {
    id: "skills",
    label: "Skills",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2l9 5-9 5-9-5 9-5z" />
        <path d="M3 8v6l9 5 9-5V8" />
        <path d="M12 13v8" />
      </svg>
    ),
  },
  {
    id: "server",
    label: "Server",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="2" width="20" height="8" rx="2" />
        <rect x="2" y="14" width="20" height="8" rx="2" />
        <circle cx="6" cy="6" r="1" fill="currentColor" />
        <circle cx="6" cy="18" r="1" fill="currentColor" />
      </svg>
    ),
  },
  {
    id: "about",
    label: "About",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <path d="M12 16v-4M12 8h.01" />
      </svg>
    ),
  },
]

const GeneralIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21a8 8 0 0 1 16 0" />
  </svg>
)

const ProvidersIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M9 2v6M15 2v6M7 8h10v3a5 5 0 0 1-10 0zM12 16v6" />
  </svg>
)

const ModelIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 2l9 5-9 5-9-5 9-5z" />
    <path d="M3 8v6l9 5 9-5V8" />
    <path d="M12 13v8" />
  </svg>
)

const ServerIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="2" width="20" height="8" rx="2" />
    <rect x="2" y="14" width="20" height="8" rx="2" />
    <circle cx="6" cy="6" r="1" fill="currentColor" />
    <circle cx="6" cy="18" r="1" fill="currentColor" />
  </svg>
)

const ConversationsIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
)

const SkillsIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 2l9 5-9 5-9-5 9-5z" />
    <path d="M3 8v6l9 5 9-5V8" />
    <path d="M12 13v8" />
  </svg>
)

const AboutIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" />
    <path d="M12 16v-4M12 8h.01" />
  </svg>
)

export function SettingsModal({ initialPage, providers, model, directory, onModelChange, onRefreshProviders, onClose }: Props) {
  const [page, setPage] = useState<Page>((initialPage as Page) || "general")
  const [serverUrl, setServerUrl] = useState("")
  const [serverStatus, setServerStatus] = useState<Status>({ kind: "idle" })
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [skillsLoading, setSkillsLoading] = useState(false)
  const [skillsStatus, setSkillsStatus] = useState<Status>({ kind: "idle" })
  const [compactionThreshold, setCompactionThreshold] = useState<string>("")
  const [compactionEnabled, setCompactionEnabled] = useState(false)
  const [compStatus, setCompStatus] = useState<Status>({ kind: "idle" })
  const [userName, setUserName] = useState("")
  const [userStatus, setUserStatus] = useState<Status>({ kind: "idle" })
  const [customPrompt, setCustomPrompt] = useState("")
  const [promptStatus, setPromptStatus] = useState<Status>({ kind: "idle" })
  const [aiGreetings, setAiGreetings] = useState(false)
  const [aiSuggestions, setAiSuggestions] = useState(false)
  const [visionRedirect, setVisionRedirect] = useState(false)
  const [visionModel, setVisionModel] = useState("")
  const [audioRedirect, setAudioRedirect] = useState(false)
  const [audioModel, setAudioModel] = useState("")
  const [videoRedirect, setVideoRedirect] = useState(false)
  const [videoModel, setVideoModel] = useState("")
  const [homeRedirect, setHomeRedirect] = useState(false)
  const [homeModel, setHomeModel] = useState("")
  const customModels = useCustomModels()
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)

  useEffect(() => {
    window.mimo.getAppInfo().then(setAppInfo).catch(() => {})
  }, [])

  // provider config form
  const [pid, setPid] = useState("")
  const [pname, setPname] = useState("")
  const [baseURL, setBaseURL] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [npm, setNpm] = useState("")
  // Declared input modalities for the model being added. Without these, Aria
  // defaults a custom model to text-only and strips images before the provider.
  const [mImage, setMImage] = useState(true)
  const [mAudio, setMAudio] = useState(false)
  const [mVideo, setMVideo] = useState(false)
  const [mPdf, setMPdf] = useState(false)
  const [modelId, setModelId] = useState("")
  const [status, setStatus] = useState<Status>({ kind: "idle" })

  useEffect(() => {
    window.mimo.getSetting("serverUrl").then((v) => setServerUrl(typeof v === "string" ? v : ""))
  }, [])

  useEffect(() => {
    window.mimo.getSetting("userName").then((v) => setUserName(typeof v === "string" ? v : ""))
  }, [])

  useEffect(() => {
    window.mimo.getSetting("aiGreetings").then((v) => setAiGreetings(v === true))
    window.mimo.getSetting("aiSuggestions").then((v) => setAiSuggestions(v === true))
  }, [])

  useEffect(() => {
    window.mimo.getSetting("visionRedirect").then((v) => setVisionRedirect(v === true))
    window.mimo.getSetting("visionModel").then((v) => {
      const m = v as { providerID?: string; modelID?: string } | null
      if (m?.providerID && m?.modelID) setVisionModel(`${m.providerID}/${m.modelID}`)
    })
  }, [])

  const toggleVisionRedirect = () => {
    setVisionRedirect((v) => {
      const next = !v
      window.mimo.setSetting("visionRedirect", next).catch(() => {})
      return next
    })
  }
  const changeVisionModel = (value: string) => {
    setVisionModel(value)
    const [providerID, ...rest] = value.split("/")
    window.mimo.setSetting("visionModel", { providerID, modelID: rest.join("/") }).catch(() => {})
  }

  useEffect(() => {
    window.mimo.getSetting("audioRedirect").then((v) => setAudioRedirect(v === true))
    window.mimo.getSetting("audioModel").then((v) => {
      const m = v as { providerID?: string; modelID?: string } | null
      if (m?.providerID && m?.modelID) setAudioModel(`${m.providerID}/${m.modelID}`)
    })
  }, [])

  const toggleAudioRedirect = () => {
    setAudioRedirect((v) => {
      const next = !v
      window.mimo.setSetting("audioRedirect", next).catch(() => {})
      return next
    })
  }
  const changeAudioModel = (value: string) => {
    setAudioModel(value)
    const [providerID, ...rest] = value.split("/")
    window.mimo.setSetting("audioModel", { providerID, modelID: rest.join("/") }).catch(() => {})
  }

  useEffect(() => {
    window.mimo.getSetting("videoRedirect").then((v) => setVideoRedirect(v === true))
    window.mimo.getSetting("videoModel").then((v) => {
      const m = v as { providerID?: string; modelID?: string } | null
      if (m?.providerID && m?.modelID) setVideoModel(`${m.providerID}/${m.modelID}`)
    })
  }, [])

  const toggleVideoRedirect = () => {
    setVideoRedirect((v) => {
      const next = !v
      window.mimo.setSetting("videoRedirect", next).catch(() => {})
      return next
    })
  }
  const changeVideoModel = (value: string) => {
    setVideoModel(value)
    const [providerID, ...rest] = value.split("/")
    window.mimo.setSetting("videoModel", { providerID, modelID: rest.join("/") }).catch(() => {})
  }

  useEffect(() => {
    window.mimo.getSetting("homeRedirect").then((v) => setHomeRedirect(v === true))
    window.mimo.getSetting("homeModel").then((v) => {
      const m = v as { providerID?: string; modelID?: string } | null
      if (m?.providerID && m?.modelID) setHomeModel(`${m.providerID}/${m.modelID}`)
    })
  }, [])

  const toggleHomeRedirect = () => {
    setHomeRedirect((v) => {
      const next = !v
      window.mimo.setSetting("homeRedirect", next).catch(() => {})
      return next
    })
  }
  const changeHomeModel = (value: string) => {
    setHomeModel(value)
    const [providerID, ...rest] = value.split("/")
    window.mimo.setSetting("homeModel", { providerID, modelID: rest.join("/") }).catch(() => {})
  }

  // ---- compact redirect ----
  const [compactRedirect, setCompactRedirect] = useState(false)
  const [compactModel, setCompactModel] = useState("")

  useEffect(() => {
    window.mimo.getSetting("compactRedirect").then((v) => setCompactRedirect(v === true))
    window.mimo.getSetting("compactModel").then((v) => {
      const m = v as { providerID?: string; modelID?: string } | null
      if (m?.providerID && m?.modelID) setCompactModel(`${m.providerID}/${m.modelID}`)
    })
  }, [])

  const toggleCompactRedirect = () => {
    setCompactRedirect((v) => {
      const next = !v
      window.mimo.setSetting("compactRedirect", next).catch(() => {})
      return next
    })
  }
  const changeCompactModel = (value: string) => {
    setCompactModel(value)
    if (!value) return
    const [providerID, ...rest] = value.split("/")
    window.mimo.setSetting("compactModel", { providerID, modelID: rest.join("/") }).catch(() => {})
    if (compactRedirect) {
      window.mimo.setCompactRedirectModel({ providerID, modelID: rest.join("/") }).catch(() => {})
    }
  }

  const toggleAiGreetings = () => {
    setAiGreetings((v) => {
      const next = !v
      window.mimo.setSetting("aiGreetings", next).catch(() => {})
      return next
    })
  }
  const toggleAiSuggestions = () => {
    setAiSuggestions((v) => {
      const next = !v
      window.mimo.setSetting("aiSuggestions", next).catch(() => {})
      return next
    })
  }

  useEffect(() => {
    window.mimo.getSetting("customPrompt").then((v) => setCustomPrompt(typeof v === "string" ? v : ""))
  }, [])

  useEffect(() => {
    window.mimo.getSetting("compaction").then((v) => {
      if (v && typeof v === "object") {
        const cfg = v as { threshold?: number; auto?: boolean }
        if (cfg.auto !== undefined) setCompactionEnabled(cfg.auto)
        if (cfg.threshold !== undefined) setCompactionThreshold(String(cfg.threshold))
      }
    })
  }, [])

  const loadSkills = useCallback(async () => {
    setSkillsLoading(true)
    try {
      const list = await window.mimo.getSkills(directory ?? undefined)
      setSkills(list)
    } catch {
      setSkills([])
    }
    setSkillsLoading(false)
  }, [directory])

  useEffect(() => {
    if (page === "skills") {
      loadSkills()
    }
  }, [page, loadSkills])

  const modelOptions: { value: string; label: string }[] = []
  const seen = new Set<string>()
  const pushOpt = (providerID: string, mId: string, label: string) => {
    const value = `${providerID}/${mId}`
    if (seen.has(value)) return
    seen.add(value)
    modelOptions.push({ value, label })
  }
  if (providers) {
    const connected = new Set(providers.connected ?? [])
    for (const p of providers.all ?? []) {
      if (connected.size > 0 && !connected.has(p.id)) continue
      for (const m of Object.values(p.models ?? {})) pushOpt(p.id, m.id, `${p.name} · ${m.name}`)
    }
  }
  for (const c of customModels) pushOpt(c.providerID, c.modelID, `${c.label || `${c.providerID} · ${c.modelID}`} (custom)`)

  const saveProvider = async () => {
    const providerID = pid.trim()
    const mId = modelId.trim()
    if (!providerID || !mId) return
    setStatus({ kind: "saving" })
    try {
      const entry: ProviderConfigInput = {}
      if (pname.trim()) entry.name = pname.trim()
      const npmPkg = npm.trim() || (baseURL.trim() ? "@ai-sdk/openai-compatible" : "")
      if (npmPkg) entry.npm = npmPkg
      const options: Record<string, unknown> = {}
      if (baseURL.trim()) options.baseURL = baseURL.trim()
      if (apiKey.trim()) options.apiKey = apiKey.trim()
      if (Object.keys(options).length) entry.options = options
      const inputModalities = [
        "text",
        ...(mImage ? ["image"] : []),
        ...(mAudio ? ["audio"] : []),
        ...(mVideo ? ["video"] : []),
        ...(mPdf ? ["pdf"] : []),
      ]
      entry.models = {
        [mId]: {
          name: pname.trim() ? `${pname.trim()} ${mId}` : mId,
          attachment: inputModalities.length > 1,
          modalities: { input: inputModalities, output: ["text"] },
        },
      }

      // Write the provider into the GLOBAL server config via the server API
      // (PATCH /global/config) so the server itself manages reading, writing,
      // and invalidating instances — no path-mismatch risk. This ensures the
      // model resolves in every chat/tasker directory.
      if (apiKey.trim()) {
        await window.mimo.setAuth(providerID, { type: "api", key: apiKey.trim() }).catch(() => {})
      }
      // Use setGlobalProvider (not updateGlobalConfig) so that stale per-directory
      // copies of this provider get purged (removeProviderFromConfigs) — otherwise
      // cached instances shadow the global entry and cause "Model not found".
      await window.mimo.setGlobalProvider(providerID, entry)
      // Force re-read the provider list so the model selector updates
      await onRefreshProviders()

      const label = pname.trim() ? `${pname.trim()} · ${mId}` : `${providerID} · ${mId}`
      const next: CustomModel[] = [
        ...customModels.filter((c) => !(c.providerID === providerID && c.modelID === mId)),
        { providerID, modelID: mId, label },
      ]
      await saveCustomModels(next)
      onModelChange({ providerID, modelID: mId })

      // Verify: the provider+model should now be live in every chat directory
      const provs = await window.mimo.getProviders().catch(() => null)
      const liveProvider = provs?.all?.find((p) => p.id === providerID)
      const modelListed = liveProvider ? Object.keys(liveProvider.models ?? {}).includes(mId) : false

      setApiKey("")
      if (modelListed) {
        setStatus({ kind: "ok", msg: `Configured and verified ${providerID} / ${mId} (available in every chat).` })
      } else {
        setStatus({
          kind: "error",
          msg: `Saved, but the server did not register model "${mId}". Models seen: ${liveProvider ? Object.keys(liveProvider.models ?? {}).join(", ") || "none" : "provider not loaded"}. Try restarting the app.`,
        })
      }
    } catch (e: any) {
      setStatus({ kind: "error", msg: String(e?.message ?? e) })
    }
  }

  const removeCustom = async (c: CustomModel) => {
    await saveCustomModels(customModels.filter((x) => !(x.providerID === c.providerID && x.modelID === c.modelID)))
    await window.mimo.removeProvider(c.providerID).catch(() => {})
    await onRefreshProviders()
  }

  const saveCustomPrompt = async () => {
    setPromptStatus({ kind: "saving" })
    try {
      const content = customPrompt.trim()
      await window.mimo.setSetting("customPrompt", content)
      await window.mimo.setCustomPrompt(content)
      setPromptStatus({ kind: "ok", msg: content ? "Custom instructions saved." : "Custom instructions cleared." })
    } catch (e: any) {
      setPromptStatus({ kind: "error", msg: String(e?.message ?? e) })
    }
  }

  const saveUserName = async () => {
    setUserStatus({ kind: "saving" })
    try {
      const name = userName.trim()
      await window.mimo.setSetting("userName", name)
      await window.mimo.setUserName(name)
      setUserStatus({ kind: "ok", msg: name ? `Saved — Aria will address you as ${name}.` : "Cleared." })
    } catch (e: any) {
      setUserStatus({ kind: "error", msg: String(e?.message ?? e) })
    }
  }

  const saveServerUrl = async () => {
    setServerStatus({ kind: "saving" })
    try {
      const url = serverUrl.trim() || null
      const st = await window.mimo.reconnectServer(url, null)
      if (st.state === "error") {
        setServerStatus({ kind: "error", msg: (st as { message?: string }).message || "Could not connect." })
      } else {
        setServerStatus({ kind: "ok", msg: url ? `Connected to ${url}.` : "Reverted to the bundled server." })
      }
    } catch (e: any) {
      setServerStatus({ kind: "error", msg: String(e?.message ?? e) })
    }
  }

  const saveCompaction = async () => {
    setCompStatus({ kind: "saving" })
    try {
      const threshold = compactionThreshold.trim() ? parseInt(compactionThreshold.trim(), 10) : undefined
      if (threshold && (threshold < 1000 || threshold > 1000000)) {
        setCompStatus({ kind: "error", msg: "Threshold must be between 1,000 and 1,000,000" })
        return
      }
      await window.mimo.setSetting("compaction", {
        auto: compactionEnabled,
        threshold,
      })
      // Persist into the GLOBAL server config so the server actually honors it
      // (auto on/off + the trigger threshold), not just the local settings store.
      await window.mimo.setCompactionThreshold(threshold ?? null, compactionEnabled)

      // Also persist the compact model redirect into the server's global config
      // so auto-compaction uses the dedicated model on the server side.
      if (compactRedirect && compactModel) {
        const [providerID, ...rest] = compactModel.split("/")
        await window.mimo.setCompactRedirectModel({ providerID, modelID: rest.join("/") })
      } else {
        await window.mimo.setCompactRedirectModel(null)
      }

      setCompStatus({ kind: "ok", msg: "Compaction settings saved globally" })
    } catch (e: any) {
      setCompStatus({ kind: "error", msg: String(e?.message ?? e) })
    }
  }

  const installSkill = async () => {
    setSkillsStatus({ kind: "saving" })
    try {
      const dir = await window.mimo.pickDirectory()
      if (!dir) {
        setSkillsStatus({ kind: "idle" })
        return
      }
      const installed = await window.mimo.installSkill(dir)
      setSkills((prev) => [...prev.filter((s) => s.name !== installed.name), installed])
      setSkillsStatus({ kind: "ok", msg: `Installed skill: ${installed.name}` })
    } catch (e: any) {
      setSkillsStatus({ kind: "error", msg: String(e?.message ?? e) })
    }
  }

  const installSkillFile = async () => {
    setSkillsStatus({ kind: "saving" })
    try {
      const filePath = await window.mimo.pickSkillFile()
      if (!filePath) {
        setSkillsStatus({ kind: "idle" })
        return
      }
      const installed = await window.mimo.installSkillFile(filePath)
      setSkills((prev) => [...prev.filter((s) => s.name !== installed.name), installed])
      setSkillsStatus({ kind: "ok", msg: `Installed skill: ${installed.name}` })
    } catch (e: any) {
      setSkillsStatus({ kind: "error", msg: String(e?.message ?? e) })
    }
  }

  const uninstallSkill = async (name: string) => {
    try {
      await window.mimo.uninstallSkill(name)
      setSkills((prev) => prev.filter((s) => s.name !== name))
    } catch (e: any) {
      setSkillsStatus({ kind: "error", msg: String(e?.message ?? e) })
    }
  }

  const [baseProviders, setBaseProviders] = useState<string[]>([])
  const [removingProvider, setRemovingProvider] = useState<string | null>(null)

  useEffect(() => {
    window.mimo.getSetting("baseConfig").then((v) => {
      const prov = (v as { provider?: Record<string, unknown> } | null)?.provider
      setBaseProviders(prov ? Object.keys(prov) : [])
    })
  }, [page])

  const allProviderIds = Array.from(
    new Set<string>([...(providers?.connected ?? []), ...baseProviders, ...customModels.map((c) => c.providerID)]),
  ).sort()

  const providerLabel = (id: string) => {
    const p = providers?.all?.find((x) => x.id === id)
    const n = p ? Object.keys(p.models ?? {}).length : customModels.filter((c) => c.providerID === id).length
    return `${n} model${n === 1 ? "" : "s"}`
  }

  const handleRemoveProvider = async (id: string) => {
    if (removingProvider) return
    setRemovingProvider(id)
    try {
      await window.mimo.removeProvider(id)
      await loadCustomModels()
      await onRefreshProviders()
      setBaseProviders((ps) => ps.filter((p) => p !== id))
    } catch {
      /* ignore */
    } finally {
      setRemovingProvider(null)
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="settings-modal" onMouseDown={(e) => e.stopPropagation()}>
        <button className="settings-close" onClick={onClose} title="Close settings" aria-label="Close settings">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
        <nav className="settings-nav">
          <h2 className="settings-title">Settings</h2>
          {PAGES.map((p) => (
            <button
              key={p.id}
              className={"settings-nav-item" + (page === p.id ? " active" : "")}
              onClick={() => { setPage(p.id); setStatus({ kind: "idle" }) }}
            >
              {p.icon}
              <span>{p.label}</span>
            </button>
          ))}
        </nav>

        <div className="settings-content">
          {page === "general" && (
            <>
              <h3 className="settings-page-title"><GeneralIcon /> General</h3>

              <div className="settings-field">
                <label htmlFor="user-name">Your name</label>
                <input
                  id="user-name"
                  placeholder="e.g. Junji"
                  value={userName}
                  onChange={(e) => setUserName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") saveUserName() }}
                />
                <div className="hint">
                  How Aria should address you. Saved into the server's global AGENTS.md, so it applies to every
                  conversation.
                </div>
                {userStatus.kind === "ok" && <div className="form-msg ok">{userStatus.msg}</div>}
                {userStatus.kind === "error" && <div className="form-msg err">{userStatus.msg}</div>}
                <div className="settings-inline-actions">
                  <button className="primary" onClick={saveUserName} disabled={userStatus.kind === "saving"}>
                    {userStatus.kind === "saving" ? "Saving…" : "Save"}
                  </button>
                </div>
              </div>

              <div className="settings-divider" />

              <div className="settings-row" onClick={toggleAiGreetings} role="button">
                <div className="settings-row-text">
                  <div className="settings-row-title">AI-generated greetings</div>
                  <div className="settings-row-desc">
                    Generate a fresh home-screen greeting for new chats and tasks. Falls back to the default if it can't be generated.
                  </div>
                </div>
                <button
                  type="button"
                  className={"toggle" + (aiGreetings ? " on" : "")}
                  aria-pressed={aiGreetings}
                  onClick={(e) => { e.stopPropagation(); toggleAiGreetings() }}
                >
                  <span className="knob" />
                </button>
              </div>

              <div className="settings-row" onClick={toggleAiSuggestions} role="button">
                <div className="settings-row-text">
                  <div className="settings-row-title">AI-generated suggestions</div>
                  <div className="settings-row-desc">
                    Replace the default suggestion chips with four fresh ideas. Falls back to the defaults on any error.
                  </div>
                </div>
                <button
                  type="button"
                  className={"toggle" + (aiSuggestions ? " on" : "")}
                  aria-pressed={aiSuggestions}
                  onClick={(e) => { e.stopPropagation(); toggleAiSuggestions() }}
                >
                  <span className="knob" />
                </button>
          </div>

          <div className="settings-divider" />

          <div className="settings-row" onClick={toggleHomeRedirect} role="button">
            <div className="settings-row-text">
              <div className="settings-row-title">Redirect home-screen generation</div>
              <div className="settings-row-desc">
                When enabled, use a specific model for generating home-screen greetings and suggestions instead of the active model.
              </div>
            </div>
            <button
              type="button"
              className={"toggle" + (homeRedirect ? " on" : "")}
              aria-pressed={homeRedirect}
              onClick={(e) => { e.stopPropagation(); toggleHomeRedirect() }}
            >
              <span className="knob" />
            </button>
          </div>

          {homeRedirect && (
            <div className="settings-field">
              <label htmlFor="home-model">Home-screen model</label>
              <select id="home-model" value={homeModel} onChange={(e) => changeHomeModel(e.target.value)}>
                {modelOptions.length === 0 && <option value="">No models available</option>}
                {modelOptions.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              <div className="hint">Used only for AI-generated greetings and suggestion chips on the home screen.</div>
            </div>
          )}
        </>
      )}

      {page === "models" && (
            <>
              <h3 className="settings-page-title"><ModelIcon /> Models</h3>

              <div className="settings-field">
                <label>Active model</label>
                <select
                  value={model ? `${model.providerID}/${model.modelID}` : ""}
                  onChange={(e) => {
                    const [providerID, ...rest] = e.target.value.split("/")
                    onModelChange({ providerID, modelID: rest.join("/") })
                  }}
                >
                  {modelOptions.length === 0 && <option value="">No models available</option>}
                  {modelOptions.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <div className="hint">Connected: {(providers?.connected ?? []).join(", ") || "none"}.</div>
              </div>

              <div className="settings-divider" />

              <div className="settings-row" onClick={toggleVisionRedirect} role="button">
                <div className="settings-row-text">
                  <div className="settings-row-title">Redirect image attachments</div>
                  <div className="settings-row-desc">
                    When a message includes an image, send that turn to a vision-capable model instead of the active one.
                  </div>
                </div>
                <button
                  type="button"
                  className={"toggle" + (visionRedirect ? " on" : "")}
                  aria-pressed={visionRedirect}
                  onClick={(e) => { e.stopPropagation(); toggleVisionRedirect() }}
                >
                  <span className="knob" />
                </button>
              </div>

              {visionRedirect && (
                <div className="settings-field">
                  <label htmlFor="vision-model">Vision model</label>
                  <select id="vision-model" value={visionModel} onChange={(e) => changeVisionModel(e.target.value)}>
                    {modelOptions.length === 0 && <option value="">No models available</option>}
                    {modelOptions.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                  <div className="hint">Used only for messages that contain an image attachment.</div>
                </div>
              )}

              <div className="settings-row" onClick={toggleAudioRedirect} role="button">
                <div className="settings-row-text">
                  <div className="settings-row-title">Redirect audio attachments</div>
                  <div className="settings-row-desc">
                    When a message includes audio (e.g. a voice recording), send that turn to an audio-capable model instead of the active one.
                  </div>
                </div>
                <button
                  type="button"
                  className={"toggle" + (audioRedirect ? " on" : "")}
                  aria-pressed={audioRedirect}
                  onClick={(e) => { e.stopPropagation(); toggleAudioRedirect() }}
                >
                  <span className="knob" />
                </button>
              </div>

              {audioRedirect && (
                <div className="settings-field">
                  <label htmlFor="audio-model">Audio model</label>
                  <select id="audio-model" value={audioModel} onChange={(e) => changeAudioModel(e.target.value)}>
                    {modelOptions.length === 0 && <option value="">No models available</option>}
                    {modelOptions.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                  <div className="hint">Used only for messages that contain an audio attachment.</div>
                </div>
              )}

              <div className="settings-row" onClick={toggleVideoRedirect} role="button">
                <div className="settings-row-text">
                  <div className="settings-row-title">Redirect video attachments</div>
                  <div className="settings-row-desc">
                    When a message includes a video, send that turn to a video-capable model instead of the active one.
                  </div>
                </div>
                <button
                  type="button"
                  className={"toggle" + (videoRedirect ? " on" : "")}
                  aria-pressed={videoRedirect}
                  onClick={(e) => { e.stopPropagation(); toggleVideoRedirect() }}
                >
                  <span className="knob" />
                </button>
              </div>

              {videoRedirect && (
                <div className="settings-field">
                  <label htmlFor="video-model">Video model</label>
                  <select id="video-model" value={videoModel} onChange={(e) => changeVideoModel(e.target.value)}>
                    {modelOptions.length === 0 && <option value="">No models available</option>}
                    {modelOptions.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                  <div className="hint">Used only for messages that contain a video attachment.</div>
                </div>
              )}


            </>
          )}

          {page === "providers" && (
            <>
              <h3 className="settings-page-title"><ProvidersIcon /> Providers</h3>

              {allProviderIds.length > 0 ? (
                <div className="settings-field">
                  <label>Configured providers</label>
                  <div className="custom-list">
                    {allProviderIds.map((id) => (
                      <div className="custom-row" key={id}>
                        <span className="custom-meta">
                          <strong>{id}</strong>
                          <span className="custom-id">{providerLabel(id)}</span>
                        </span>
                        <button
                          className="custom-remove"
                          disabled={removingProvider === id}
                          onClick={() => handleRemoveProvider(id)}
                        >
                          {removingProvider === id ? "Removing…" : "Remove"}
                        </button>
                      </div>
                    ))}
                  </div>
                  <div className="hint">
                    Removing clears the provider's API key, config, and custom models from the app and the server.
                  </div>
                </div>
              ) : (
                <div className="settings-field">
                  <div className="skill-empty">No providers configured yet. Add one below.</div>
                </div>
              )}

              <div className="settings-divider" />

              <div className="settings-field">
                <label>Add a provider</label>
                <div className="provider-form">
                  <input placeholder="Provider ID (e.g. openai, my-llm)" value={pid} onChange={(e) => setPid(e.target.value)} />
                  <input placeholder="Display name (optional)" value={pname} onChange={(e) => setPname(e.target.value)} />
                  <input placeholder="Base URL (optional)" value={baseURL} onChange={(e) => setBaseURL(e.target.value)} />
                  <input placeholder="API key" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
                  <input placeholder="Model ID (e.g. gpt-4o)" value={modelId} onChange={(e) => setModelId(e.target.value)} />
                  <input placeholder="npm package (optional)" value={npm} onChange={(e) => setNpm(e.target.value)} />
                  <div className="provider-modalities">
                    <span className="provider-modalities-label">Input types</span>
                    <button type="button" className={"mod-chip" + (mImage ? " on" : "")} onClick={() => setMImage((v) => !v)}>Image</button>
                    <button type="button" className={"mod-chip" + (mAudio ? " on" : "")} onClick={() => setMAudio((v) => !v)}>Audio</button>
                    <button type="button" className={"mod-chip" + (mVideo ? " on" : "")} onClick={() => setMVideo((v) => !v)}>Video</button>
                    <button type="button" className={"mod-chip" + (mPdf ? " on" : "")} onClick={() => setMPdf((v) => !v)}>PDF</button>
                  </div>
                  <button className="primary" onClick={saveProvider} disabled={!pid.trim() || !modelId.trim() || status.kind === "saving"}>
                    {status.kind === "saving" ? "Saving…" : "Save provider"}
                  </button>
                </div>
                {status.kind === "ok" && <div className="form-msg ok">{status.msg}</div>}
                {status.kind === "error" && <div className="form-msg err">{status.msg}</div>}
              </div>

              {customModels.length > 0 && (
                <div className="settings-field">
                  <div className="settings-divider" />
                  <label>Custom models</label>
                  <div className="custom-list">
                    {customModels.map((c) => (
                      <div className="custom-row" key={`${c.providerID}/${c.modelID}`}>
                        <span className="custom-meta">
                          <strong>{c.label || c.modelID}</strong>
                          <span className="custom-id">{c.providerID} / {c.modelID}</span>
                        </span>
                        <button className="custom-remove" onClick={() => removeCustom(c)}>Remove</button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {page === "skills" && (
            <>
              <h3 className="settings-page-title"><SkillsIcon /> Skills</h3>

              <div className="settings-field">
                <label>Install a new skill</label>
                <div className="skill-install-bar">
                  <button className="skill-install-btn" onClick={installSkill} disabled={skillsLoading || skillsStatus.kind === "saving"}>
                    {skillsStatus.kind === "saving" ? "Installing…" : "From folder"}
                  </button>
                  <button className="skill-install-btn secondary" onClick={installSkillFile} disabled={skillsLoading || skillsStatus.kind === "saving"}>
                    From file
                  </button>
                </div>
                <div className="hint">Choose a folder with SKILL.md, or a .skill / .zip package.</div>
                {skillsStatus.kind === "ok" && <div className="form-msg ok">{skillsStatus.msg}</div>}
                {skillsStatus.kind === "error" && <div className="form-msg err">{skillsStatus.msg}</div>}
              </div>

              <div className="settings-divider" />

              <div className="settings-field">
                <label>Installed skills</label>
                {skillsLoading ? (
                  <div className="hint">Loading…</div>
                ) : skills.length === 0 ? (
                  <div className="skill-empty">No skills installed yet. Install one from a folder above.</div>
                ) : (
                  <div className="skill-list">
                    {skills.map((s) => (
                      <div className="skill-row" key={s.name}>
                        <div className="skill-icon-wrap"><SkillsIcon /></div>
                        <span className="custom-meta">
                          <strong>{s.name}</strong>
                          <span className="custom-id">{s.description || "No description"}</span>
                        </span>
                        <button className="custom-remove" onClick={() => uninstallSkill(s.name)}>Remove</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}

          {page === "server" && (
            <>
              <h3 className="settings-page-title"><ServerIcon /> Server</h3>

              <div className="settings-field">
                <label>Custom server URL</label>
                <input
                  value={serverUrl}
                  placeholder="http://127.0.0.1:4096 — leave blank to auto-launch"
                  onChange={(e) => setServerUrl(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") saveServerUrl() }}
                />
                <div className="hint">
                  Leave blank to let the app launch its own server. Set a URL to attach to an already-running MiMo Code
                  server instead — applied immediately, no restart needed.
                </div>
                {serverStatus.kind === "ok" && <div className="form-msg ok">{serverStatus.msg}</div>}
                {serverStatus.kind === "error" && <div className="form-msg err">{serverStatus.msg}</div>}
                <div className="settings-inline-actions">
                  <button className="primary" onClick={saveServerUrl} disabled={serverStatus.kind === "saving"}>
                    {serverStatus.kind === "saving" ? "Connecting…" : "Save & connect"}
                  </button>
                </div>
              </div>
            </>
          )}

          {page === "conversations" && (
            <>
              <h3 className="settings-page-title"><ConversationsIcon /> Conversations</h3>

              <div className="settings-field">
                <label htmlFor="custom-prompt">Custom instructions</label>
                <textarea
                  id="custom-prompt"
                  className="settings-textarea"
                  rows={6}
                  placeholder={"e.g. Always answer concisely. Prefer TypeScript. Show trade-offs before recommending an approach."}
                  value={customPrompt}
                  onChange={(e) => setCustomPrompt(e.target.value)}
                />
                <div className="hint">
                  Free-form guidance applied to every conversation. Saved into the server's global AGENTS.md.
                </div>
                {promptStatus.kind === "ok" && <div className="form-msg ok">{promptStatus.msg}</div>}
                {promptStatus.kind === "error" && <div className="form-msg err">{promptStatus.msg}</div>}
                <div className="settings-inline-actions">
                  <button className="primary" onClick={saveCustomPrompt} disabled={promptStatus.kind === "saving"}>
                    {promptStatus.kind === "saving" ? "Saving…" : "Save instructions"}
                  </button>
                </div>
              </div>

              <div className="settings-divider" />

              <div className="settings-row" onClick={() => setCompactionEnabled((v) => !v)} role="button">
                <div className="settings-row-text">
                  <div className="settings-row-title">Auto-compaction</div>
                  <div className="settings-row-desc">
                    Summarize older history to keep long conversations within the context limit.
                  </div>
                </div>
                <button
                  type="button"
                  className={"toggle" + (compactionEnabled ? " on" : "")}
                  aria-pressed={compactionEnabled}
                  onClick={(e) => { e.stopPropagation(); setCompactionEnabled((v) => !v) }}
                >
                  <span className="knob" />
                </button>
              </div>

              <div className={"settings-field" + (compactionEnabled ? "" : " disabled")}>
                <label htmlFor="compaction-threshold">Compaction threshold (tokens)</label>
                <input
                  id="compaction-threshold"
                  type="number"
                  value={compactionThreshold}
                  placeholder="Model's context limit"
                  min="1000"
                  max="1000000"
                  onChange={(e) => setCompactionThreshold(e.target.value)}
                  disabled={!compactionEnabled}
                />
                <div className="hint">
                  Trigger compaction at this token count instead of the model's reported limit. Leave blank to use the
                  model's limit. Applies globally; 100000 (100K) suits most providers.
                </div>
              </div>

              {compStatus.kind === "ok" && <div className="form-msg ok">{compStatus.msg}</div>}
              {compStatus.kind === "error" && <div className="form-msg err">{compStatus.msg}</div>}

              <div className="settings-divider" />

              <div className="settings-row" onClick={toggleCompactRedirect} role="button">
                <div className="settings-row-text">
                  <div className="settings-row-title">Compact with a specific model</div>
                  <div className="settings-row-desc">
                    Use a dedicated model for auto-compaction and /compact instead of the active one.
                  </div>
                </div>
                <button
                  type="button"
                  className={"toggle" + (compactRedirect ? " on" : "")}
                  aria-pressed={compactRedirect}
                  onClick={(e) => { e.stopPropagation(); toggleCompactRedirect() }}
                >
                  <span className="knob" />
                </button>
              </div>

              {compactRedirect && (
                <div className="settings-field">
                  <label htmlFor="compact-model">Compact model</label>
                  <select id="compact-model" value={compactModel} onChange={(e) => changeCompactModel(e.target.value)}>
                    <option value="">Select a model…</option>
                    {modelOptions.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                  <div className="hint">Used only for compaction runs (auto and manual).</div>
                </div>
              )}

              <div className="settings-inline-actions">
                <button className="primary" onClick={saveCompaction} disabled={compStatus.kind === "saving"}>
                  {compStatus.kind === "saving" ? "Saving…" : "Save globally"}
                </button>
              </div>
            </>
          )}

          {page === "about" && (
            <>
              <h3 className="settings-page-title"><AboutIcon /> About</h3>

              {appInfo ? (
                <div className="settings-field">
                  <div className="about-name">
                    <img className="about-name-logo" src={ariaTextImg} alt="Aria" />
                    <span className="about-name-pill">Chat</span>
                  </div>
                  <div className="about-version">Version {appInfo.appVersion}</div>

                  <div className="settings-divider" />

                  <div className="about-details">
                    <div className="about-row">
                      <span className="about-label">Electron</span>
                      <span className="about-value">{appInfo.electronVersion}</span>
                    </div>
                    <div className="about-row">
                      <span className="about-label">Chromium</span>
                      <span className="about-value">{appInfo.chromeVersion}</span>
                    </div>
                    <div className="about-row">
                      <span className="about-label">Node.js</span>
                      <span className="about-value">{appInfo.nodeVersion}</span>
                    </div>
                    <div className="about-row">
                      <span className="about-label">Platform</span>
                      <span className="about-value">{appInfo.platform} ({appInfo.arch})</span>
                    </div>
                  </div>

                  <div className="settings-divider" />

                  <div className="about-donate">
                    <div className="about-donate-label">Support this project</div>
                    <div className="about-donate-btns">
                      <a className="about-donate-btn" href="https://ko-fi.com/gabrieljamh" target="_blank" rel="noopener noreferrer">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7 6 12 6 12s6-5 6-12z"/><circle cx="12" cy="8" r="2"/></svg>
                        Ko-fi
                      </a>
                      <a className="about-donate-btn" href="https://www.paypal.com/donate/?business=8Y2R4BCT7XF6E&no_recurring=0&currency_code=USD" target="_blank" rel="noopener noreferrer">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>
                        PayPal
                      </a>
                    </div>
                  </div>

                  <div className="settings-divider" />

                  <div className="about-footer">
                    Built by Junji at Project BomberCraft. Powered by MiMo Code (open source).
                    <br /><br />
                    Copyright &copy; 2026 MiMo Code, Xiaomi Corporation<br />
                    Copyright &copy; 2025 opencode
                  </div>
                </div>
              ) : (
                <div className="settings-field">
                  <div className="hint">Loading…</div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
