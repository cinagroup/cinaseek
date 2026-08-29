import { classifyRpcError, logRpcFailure } from "../rpcErrors";
import { useState, useEffect, useRef, useCallback, type FormEvent } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useKumoToastManager } from "@cloudflare/kumo";
import { CaretDown, Plug, Plus } from "@phosphor-icons/react";
import { ChatInput } from "../ChatInterface";
import MeshBackground from "../components/MeshBackground";
import HomeTaskSuggestions from "../components/AppShell/HomeTaskSuggestions";
import { useAuthenticatedApi, useOptionalAuthenticatedApi } from "../AuthContext";
import { RpcStub } from "capnweb";
import {
  Overseer,
  AiChatAuthorInfo,
  CapsuleSpecifier,
  ChatAttachmentHandle,
  MessageFormatRef,
  SlashCommandRequest,
} from "@gadgets/workshop-shared/api";
import {
  getStoredSelectedModel,
  persistSelectedModel,
} from "../modelSelection";
import { useDocumentTitle } from "../useDocumentTitle";
import { homePromptFromSearch } from "../homePrompt";
import { composerDraftStorageKey } from "../composerDraft";
import {
  consumePendingHomePrompt,
  peekPendingHomePrompt,
  requestAccessLogin,
  savePendingHomePrompt,
} from "../accessSession";
import { useTranslation } from "../i18n";

type HomeSearch = { prompt?: string };

export const Route = createFileRoute("/")({
  component: HomePage,
  validateSearch: (search: Record<string, unknown>): HomeSearch => ({
    prompt: homePromptFromSearch(search.prompt),
  }),
});

// The Home page is the "new workspace" launcher. Persistent navigation (recents, favorites) lives
// in the AppShell rail, so this page focuses on a single thing: composing the first message of a
// new gadget — a centered column with a hero, the prompt composer, and a few task suggestions.
function HomePage() {
  const auth = useOptionalAuthenticatedApi();
  const prompt = Route.useSearch().prompt;
  return auth
    ? <AuthenticatedHomePage prompt={prompt} />
    : <GuestHomePage prompt={prompt} />;
}

function AuthenticatedHomePage({ prompt }: HomeSearch) {
  const [initialPrompt] = useState(() => prompt ?? consumePendingHomePrompt() ?? undefined);
  return <HomePageContent prompt={initialPrompt} />;
}

function GuestHomePage({ prompt }: HomeSearch) {
  const { t } = useTranslation('home');
  const { t: trustT } = useTranslation('trust');
  useDocumentTitle(t('pageTitle'));
  const navigate = useNavigate();
  const [input, setInput] = useState(() => prompt ?? peekPendingHomePrompt() ?? "");

  useEffect(() => {
    if (!prompt) return;
    setInput(prompt);
    savePendingHomePrompt(prompt);
    navigate({ to: "/", search: {}, replace: true });
  }, [navigate, prompt]);

  const updateInput = useCallback((value: string) => {
    setInput(value);
    savePendingHomePrompt(value);
  }, []);

  const signIn = useCallback(() => {
    savePendingHomePrompt(input);
    requestAccessLogin("/");
  }, [input]);

  const submit = useCallback((event?: FormEvent) => {
    event?.preventDefault();
    if (!input.trim()) return;
    signIn();
  }, [input, signIn]);

  return (
    <div className="relative isolate flex min-h-full w-full flex-col items-center justify-start px-4 pb-16 pt-10 sm:px-8 sm:pt-16 lg:pt-24">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[460px] overflow-hidden"
        style={{
          maskImage: "linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,1) 45%, rgba(0,0,0,0) 95%)",
          WebkitMaskImage: "linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,1) 45%, rgba(0,0,0,0) 95%)",
        }}
      >
        <MeshBackground />
      </div>
      <div className="flex w-full max-w-2xl flex-col items-stretch gap-8">
        <header className="text-center">
          <h1 className="text-3xl font-semibold tracking-tight leading-tight text-kumo-default sm:text-4xl">
            {t('hero.title')}
          </h1>
          <p className="mx-auto mt-3 max-w-md text-[14px] leading-5 tracking-[-0.25px] text-kumo-subtle">
            {t('hero.subtitle')}
          </p>
        </header>

        <form onSubmit={submit} className="relative isolate px-4 py-4">
          <div className="themed-prompt-card-shadow relative overflow-visible rounded-2xl border border-kumo-line bg-kumo-control transition-shadow duration-150 ease-out focus-within:ring-2 focus-within:ring-kumo-ring/30">
            <div className="relative px-4 pb-1 pt-3">
              <textarea
                value={input}
                onChange={(event) => updateInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) submit(event);
                }}
                placeholder={t('composer.placeholder')}
                autoFocus
                rows={3}
                aria-label={t('composer.promptLabel')}
                className="relative z-[1] w-full resize-none border-none bg-transparent p-0 text-[14px] leading-[22px] tracking-[-0.25px] text-kumo-default outline-none placeholder:text-kumo-inactive"
              />
            </div>
            <div className="flex items-center justify-between gap-1.5 px-3 pb-1.5">
              <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
                <button
                  type="button"
                  onClick={signIn}
                  className="group flex h-8 w-8 flex-shrink-0 cursor-pointer items-center justify-center rounded-lg text-kumo-inactive transition-colors hover:bg-kumo-tint hover:text-kumo-subtle"
                  aria-label={t('composer.uploadSignIn')}
                  title={t('composer.uploadSignIn')}
                >
                  <Plus size={18} />
                </button>
                <button
                  type="button"
                  onClick={signIn}
                  className="inline-flex h-8 flex-shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-[13px] leading-none tracking-[-0.25px] text-kumo-inactive transition-colors hover:bg-kumo-tint hover:text-kumo-subtle"
                >
                  <Plug size={15} className="flex-shrink-0" />
                  <span>{t('composer.addResource')}</span>
                </button>
              </div>
              <div className="ml-auto flex min-w-0 flex-shrink items-center gap-1.5">
                <button
                  type="button"
                  onClick={signIn}
                  aria-label={t('composer.modelSignIn')}
                  className="group inline-flex h-8 min-w-0 max-w-[180px] cursor-pointer items-center gap-1.5 rounded-lg px-2 text-[13px] leading-5 tracking-[-0.25px] text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-default"
                >
                  <span className="min-w-0 truncate">{t('composer.chooseModel')}</span>
                  <CaretDown size={12} weight="bold" className="flex-shrink-0 text-kumo-inactive" />
                </button>
                <button
                  type="submit"
                  disabled={!input.trim()}
                  className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg bg-kumo-brand text-white transition-colors hover:bg-kumo-brand-hover disabled:cursor-not-allowed disabled:opacity-30"
                  aria-label={t('composer.sendSignIn')}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <line x1="12" y1="19" x2="12" y2="5" />
                    <polyline points="5 12 12 5 19 12" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
          <p className="mt-2 text-center text-[12px] leading-4 text-kumo-inactive">
            {t('composer.accountHint')}
          </p>
        </form>

        <HomeTaskSuggestions onPick={updateInput} />
      </div>
      <footer className="mt-14 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs text-kumo-inactive">
        <Link to="/legal/privacy" className="hover:text-kumo-brand">{trustT('privacy.shortTitle')}</Link>
        <Link to="/legal/terms" className="hover:text-kumo-brand">{trustT('terms.shortTitle')}</Link>
        <Link to="/security" className="hover:text-kumo-brand">{trustT('security.shortTitle')}</Link>
        <Link to="/support" className="hover:text-kumo-brand">{trustT('support.shortTitle')}</Link>
        <span>© {new Date().getFullYear()} CinaGroup</span>
      </footer>
    </div>
  );
}

export function HomePageContent({ prompt }: HomeSearch) {
  const { t } = useTranslation('home');
  useDocumentTitle(t('pageTitle'));

  const { authenticatedApi, currentUser } = useAuthenticatedApi();
  const navigate = useNavigate();
  const { add: addToast } = useKumoToastManager();

  const [models, setModels] = useState<AiChatAuthorInfo[]>([]);
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  // Bumped each time a task suggestion is picked; the composer re-seeds its text off the nonce.
  const [seed, setSeed] = useState<{ text: string; nonce: number } | null>(null);

  useEffect(() => {
    if (!prompt) return;
    setSeed((previous) => ({ text: prompt, nonce: (previous?.nonce ?? 0) + 1 }));
    navigate({ to: "/", search: {}, replace: true });
  }, [navigate, prompt]);

  useEffect(() => {
    let cancelled = false;
    authenticatedApi.listModels()
      .then((list) => {
        if (cancelled) return;
        setModels(list);
        setSelectedModel(getStoredSelectedModel(list));
      })
      .catch((err) => {
        logRpcFailure("Failed to fetch models:", err);
        // Toast unless it's a connection error (reconnect refetches); a do-reset here already
        // survived the Worker's same-colo retry, so the user should hear about it.
        if (classifyRpcError(err) !== "connection") {
          addToast({ title: t('errors.models'), variant: "error" });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [authenticatedApi, addToast, t]);

  const handleModelChange = useCallback((value: string | null) => {
    setSelectedModel(value);
    persistSelectedModel(value);
  }, []);

  // Pre-create a provisional gadget as soon as the user starts interacting, so that navigation
  // after submit is instant. Same pattern as before — disposed on unmount if never consumed.
  const provisionalOverseerRef = useRef<{ stub: RpcStub<Overseer> } | null>(null);

  const ensureProvisionalGadget = useCallback(() => {
    if (!provisionalOverseerRef.current) {
      const overseer = authenticatedApi.newGadget();
      provisionalOverseerRef.current = { stub: overseer };
    }
  }, [authenticatedApi]);

  useEffect(() => {
    return () => {
      provisionalOverseerRef.current?.stub[Symbol.dispose]();
      provisionalOverseerRef.current = null;
    };
  }, []);

  const handleSend = useCallback(
    async (
      message: string | SlashCommandRequest,
      modelId: string | null,
      capsules?: CapsuleSpecifier[],
      attachments?: ChatAttachmentHandle[],
      formats?: MessageFormatRef[],
    ) => {
      try {
        ensureProvisionalGadget();
        const overseer = provisionalOverseerRef.current!.stub;
        // Pipeline both independent calls in one batch, but settle both before releasing the stub.
        const [chat, {id}] = await Promise.all([
          overseer.newChat(message, modelId, capsules, attachments, formats),
          overseer.getMetadata(),
        ]);
        provisionalOverseerRef.current?.stub[Symbol.dispose]();
        provisionalOverseerRef.current = null;
        // Open the conversation we just started.
        navigate({ to: "/workspace/$id", params: { id }, search: { chat } });
      } catch (err) {
        const transient = logRpcFailure("Failed to create gadget:", err,
            { reportSite: "workspace.create" });
        // A retry reuses the provisional gadget while the draft contains gadget-scoped references.
        if (!attachments?.length && !capsules?.length) {
          provisionalOverseerRef.current?.stub[Symbol.dispose]();
          provisionalOverseerRef.current = null;
        }
        if (!transient) {
          addToast({ title: t('errors.createWorkspace'), variant: "error" });
        }
        throw err;
      }
    },
    [addToast, ensureProvisionalGadget, navigate, t],
  );

  const getOverseer = useCallback((): RpcStub<Overseer> => {
    ensureProvisionalGadget();
    return provisionalOverseerRef.current!.stub;
  }, [ensureProvisionalGadget]);

  const createCapsuleGatekeeper = useCallback(
    (accountId: number, url: string) => {
      ensureProvisionalGadget();
      return provisionalOverseerRef.current!.stub.newGatekeeper(accountId, url);
    },
    [ensureProvisionalGadget],
  );

  return (
    // Flat enterprise treatment: no mesh, no watermark hexagon, no prompt-glow. The AppShell's
    // <main> already supplies a faint dotted grid as the page background.
    <div className="relative isolate flex min-h-full w-full flex-col items-center justify-start px-4 pb-16 pt-10 sm:px-8 sm:pt-16 lg:pt-24">
      {/* The brand hex mesh, restored and de-warmed for the new system: a gentle perspective hex
          grid receding upward. Masked to fade out before the composer so it stays a quiet backdrop. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[460px] overflow-hidden"
        style={{
          maskImage:
            "linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,1) 45%, rgba(0,0,0,0) 95%)",
          WebkitMaskImage:
            "linear-gradient(to bottom, rgba(0,0,0,1) 0%, rgba(0,0,0,1) 45%, rgba(0,0,0,0) 95%)",
        }}
      >
        <MeshBackground />
      </div>
      <div className="flex w-full max-w-2xl flex-col items-stretch gap-8">
        {/* Hero */}
        <header className="text-center">
          <h1 className="text-3xl font-semibold tracking-tight leading-tight text-kumo-default sm:text-4xl">
            {t('hero.title')}
          </h1>
          <p className="mx-auto mt-3 max-w-md text-[14px] leading-5 tracking-[-0.25px] text-kumo-subtle">
            {t('hero.subtitle')}
          </p>
        </header>

        {/* Composer */}
        <ChatInput
          createCapsuleGatekeeper={createCapsuleGatekeeper}
          getOverseer={getOverseer}
          onSend={handleSend}
          isAgentActive={false}
          models={models}
          selectedModel={selectedModel}
          onModelChange={handleModelChange}
          newChat
          offerFormats
          autoFocus
          minRows={3}
          seedText={seed?.text}
          seedNonce={seed?.nonce}
          draftStorageKey={currentUser
            ? composerDraftStorageKey(currentUser.id, "home")
            : undefined}
        />

        {/* A few example work tasks to spark ideas. Picking one seeds the composer above. */}
        <HomeTaskSuggestions
          onPick={(suggestion) =>
            setSeed((prev) => ({ text: suggestion, nonce: (prev?.nonce ?? 0) + 1 }))
          }
        />
      </div>
    </div>
  );
}
