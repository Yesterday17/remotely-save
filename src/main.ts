import {
  Modal,
  Notice,
  Plugin,
  Setting,
  addIcon,
  setIcon,
  FileSystemAdapter,
  Platform,
  requestUrl,
  requireApiVersion,
  Events,
} from "obsidian";
import cloneDeep from "lodash/cloneDeep";
import { createElement, RotateCcw, RefreshCcw, FileText } from "lucide";
import type {
  RemotelySavePluginSettings,
  SyncTriggerSourceType,
} from "./baseTypes";
import {
  COMMAND_CALLBACK,
  COMMAND_CALLBACK_ONEDRIVE,
  COMMAND_CALLBACK_DROPBOX,
  COMMAND_URI,
  API_VER_ENSURE_REQURL_OK,
} from "./baseTypes";
import { importQrCodeUri } from "./importExport";
import {
  insertSyncPlanRecordByVault,
  prepareDBs,
  InternalDBs,
  clearExpiredSyncPlanRecords,
  upsertPluginVersionByVault,
  clearAllLoggerOutputRecords,
  upsertLastSuccessSyncTimeByVault,
  getLastSuccessSyncTimeByVault,
  getAllPrevSyncRecordsByVaultAndProfile,
  insertProfilerResultByVault,
} from "./localdb";
import { RemoteClient } from "./remote";
import {
  DEFAULT_DROPBOX_CONFIG,
  getAuthUrlAndVerifier as getAuthUrlAndVerifierDropbox,
  sendAuthReq as sendAuthReqDropbox,
  setConfigBySuccessfullAuthInplace as setConfigBySuccessfullAuthInplaceDropbox,
} from "./remoteForDropbox";
import {
  AccessCodeResponseSuccessfulType,
  DEFAULT_ONEDRIVE_CONFIG,
  sendAuthReq as sendAuthReqOnedrive,
  setConfigBySuccessfullAuthInplace as setConfigBySuccessfullAuthInplaceOnedrive,
} from "./remoteForOnedrive";
import { DEFAULT_S3_CONFIG } from "./remoteForS3";
import { DEFAULT_WEBDAV_CONFIG } from "./remoteForWebdav";
import { RemotelySaveSettingTab } from "./settings";
import {
  doActualSync,
  ensembleMixedEnties,
  getSyncPlanInplace,
  isPasswordOk,
  SyncStatusType,
} from "./sync";
import { messyConfigToNormal, normalConfigToMessy } from "./configPersist";
import { getLocalEntityList } from "./local";
import { I18n } from "./i18n";
import type { LangType, LangTypeAndAuto, TransItemType } from "./i18n";
import { SyncAlgoV3Modal } from "./syncAlgoV3Notice";

import AggregateError from "aggregate-error";
import { exportVaultSyncPlansToFiles } from "./debugMode";
import { changeMobileStatusBar, compareVersion } from "./misc";
import { Cipher } from "./encryptUnified";
import { Profiler } from "./profiler";

const DEFAULT_SETTINGS: RemotelySavePluginSettings = {
  s3: DEFAULT_S3_CONFIG,
  webdav: DEFAULT_WEBDAV_CONFIG,
  dropbox: DEFAULT_DROPBOX_CONFIG,
  onedrive: DEFAULT_ONEDRIVE_CONFIG,
  password: "",
  serviceType: "s3",
  currLogLevel: "info",
  // vaultRandomID: "", // deprecated
  autoRunEveryMilliseconds: -1,
  initRunAfterMilliseconds: -1,
  syncOnSaveAfterMilliseconds: -1,
  agreeToUploadExtraMetadata: true, // as of 20240106, it's safe to assume every new user agrees with this
  concurrency: 5,
  syncConfigDir: false,
  syncUnderscoreItems: false,
  lang: "auto",
  logToDB: false,
  skipSizeLargerThan: -1,
  ignorePaths: [],
  enableStatusBarInfo: true,
  deleteToWhere: "system",
  agreeToUseSyncV3: false,
  conflictAction: "keep_newer",
  howToCleanEmptyFolder: "skip",
  protectModifyPercentage: 50,
  syncDirection: "bidirectional",
  obfuscateSettingFile: true,
  enableMobileStatusBar: false,
  encryptionMethod: "unknown",
};

interface OAuth2Info {
  verifier?: string;
  helperModal?: Modal;
  authDiv?: HTMLElement;
  revokeDiv?: HTMLElement;
  revokeAuthSetting?: Setting;
}

const iconNameSyncWait = `remotely-save-sync-wait`;
const iconNameSyncRunning = `remotely-save-sync-running`;
const iconNameLogs = `remotely-save-logs`;

const getIconSvg = () => {
  const iconSvgSyncWait = createElement(RotateCcw);
  iconSvgSyncWait.setAttribute("width", "100");
  iconSvgSyncWait.setAttribute("height", "100");
  const iconSvgSyncRunning = createElement(RefreshCcw);
  iconSvgSyncRunning.setAttribute("width", "100");
  iconSvgSyncRunning.setAttribute("height", "100");
  const iconSvgLogs = createElement(FileText);
  iconSvgLogs.setAttribute("width", "100");
  iconSvgLogs.setAttribute("height", "100");
  const res = {
    iconSvgSyncWait: iconSvgSyncWait.outerHTML,
    iconSvgSyncRunning: iconSvgSyncRunning.outerHTML,
    iconSvgLogs: iconSvgLogs.outerHTML,
  };

  iconSvgSyncWait.empty();
  iconSvgSyncRunning.empty();
  iconSvgLogs.empty();
  return res;
};

export default class RemotelySavePlugin extends Plugin {
  settings!: RemotelySavePluginSettings;
  db!: InternalDBs;
  syncStatus!: SyncStatusType;
  statusBarElement!: HTMLSpanElement;
  oauth2Info!: OAuth2Info;
  currLogLevel!: string;
  currSyncMsg?: string;
  syncRibbon?: HTMLElement;
  autoRunIntervalID?: number;
  syncOnSaveIntervalID?: number;
  i18n!: I18n;
  vaultRandomID!: string;
  debugServerTemp?: string;
  syncEvent?: Events;
  appContainerObserver?: MutationObserver;

  async syncRun(triggerSource: SyncTriggerSourceType = "manual") {
    const profiler = new Profiler("start of syncRun");

    const t = (x: TransItemType, vars?: any) => {
      return this.i18n.t(x, vars);
    };

    const profileID = this.getCurrProfileID();

    const getNotice = (x: string, timeout?: number) => {
      // only show notices in manual mode
      // no notice in auto mode
      if (triggerSource === "manual" || triggerSource === "dry") {
        new Notice(x, timeout);
      }
    };
    if (this.syncStatus !== "idle") {
      // really, users don't want to see this in auto mode
      // so we use getNotice to avoid unnecessary show up
      getNotice(
        t("syncrun_alreadyrunning", {
          pluginName: this.manifest.name,
          syncStatus: this.syncStatus,
          newTriggerSource: triggerSource,
        })
      );
      if (this.currSyncMsg !== undefined && this.currSyncMsg !== "") {
        getNotice(this.currSyncMsg);
      }
      return;
    }

    let originLabel = `${this.manifest.name}`;
    if (this.syncRibbon !== undefined) {
      originLabel = this.syncRibbon.getAttribute("aria-label") as string;
    }

    try {
      console.info(
        `${
          this.manifest.id
        }-${Date.now()}: start sync, triggerSource=${triggerSource}`
      );

      if (this.syncRibbon !== undefined) {
        setIcon(this.syncRibbon, iconNameSyncRunning);
        this.syncRibbon.setAttribute(
          "aria-label",
          t("syncrun_syncingribbon", {
            pluginName: this.manifest.name,
            triggerSource: triggerSource,
          })
        );
      }

      if (triggerSource === "dry") {
        if (this.settings.currLogLevel === "info") {
          getNotice(t("syncrun_shortstep0"));
        } else {
          getNotice(t("syncrun_step0"));
        }
      }

      // change status to "syncing..." on statusbar
      if (this.statusBarElement !== undefined) {
        this.updateLastSuccessSyncMsg(-1);
      }
      //console.info(`huh ${this.settings.password}`)
      if (this.settings.currLogLevel === "info") {
        getNotice(
          t("syncrun_shortstep1", {
            serviceType: this.settings.serviceType,
          })
        );
      } else {
        getNotice(
          t("syncrun_step1", {
            serviceType: this.settings.serviceType,
          })
        );
      }

      this.syncStatus = "preparing";
      profiler.insert("finish step1");

      if (this.settings.currLogLevel === "info") {
        // pass
      } else {
        getNotice(t("syncrun_step2"));
      }
      this.syncStatus = "getting_remote_files_list";
      const self = this;
      const client = new RemoteClient(
        this.settings.serviceType,
        this.settings.s3,
        this.settings.webdav,
        this.settings.dropbox,
        this.settings.onedrive,
        this.app.vault.getName(),
        () => self.saveSettings(),
        profiler
      );
      const remoteEntityList = await client.listAllFromRemote();
      console.debug("remoteEntityList:");
      console.debug(remoteEntityList);

      profiler.insert("finish step2 (listing remote)");

      if (this.settings.currLogLevel === "info") {
        // pass
      } else {
        getNotice(t("syncrun_step3"));
      }
      this.syncStatus = "checking_password";

      const cipher = new Cipher(
        this.settings.password,
        this.settings.encryptionMethod ?? "unknown"
      );
      const passwordCheckResult = await isPasswordOk(remoteEntityList, cipher);
      if (!passwordCheckResult.ok) {
        getNotice(t("syncrun_passworderr"));
        throw Error(passwordCheckResult.reason);
      }

      profiler.insert("finish step3 (checking password)");

      if (this.settings.currLogLevel === "info") {
        // pass
      } else {
        getNotice(t("syncrun_step4"));
      }
      this.syncStatus = "getting_local_meta";
      const localEntityList = await getLocalEntityList(
        this.app.vault,
        this.settings.syncConfigDir ?? false,
        this.app.vault.configDir,
        this.manifest.id,
        profiler
      );
      console.debug("localEntityList:");
      console.debug(localEntityList);

      profiler.insert("finish step4 (local meta)");

      if (this.settings.currLogLevel === "info") {
        // pass
      } else {
        getNotice(t("syncrun_step5"));
      }
      this.syncStatus = "getting_local_prev_sync";
      const prevSyncEntityList = await getAllPrevSyncRecordsByVaultAndProfile(
        this.db,
        this.vaultRandomID,
        profileID
      );
      console.debug("prevSyncEntityList:");
      console.debug(prevSyncEntityList);

      profiler.insert("finish step5 (prev sync)");

      if (this.settings.currLogLevel === "info") {
        // pass
      } else {
        getNotice(t("syncrun_step6"));
      }
      this.syncStatus = "generating_plan";
      let mixedEntityMappings = await ensembleMixedEnties(
        localEntityList,
        prevSyncEntityList,
        remoteEntityList,
        this.settings.syncConfigDir ?? false,
        this.app.vault.configDir,
        this.settings.syncUnderscoreItems ?? false,
        this.settings.ignorePaths ?? [],
        cipher,
        this.settings.serviceType,
        profiler
      );
      profiler.insert("finish building partial mixedEntity");
      mixedEntityMappings = await getSyncPlanInplace(
        mixedEntityMappings,
        this.settings.howToCleanEmptyFolder ?? "skip",
        this.settings.skipSizeLargerThan ?? -1,
        this.settings.conflictAction ?? "keep_newer",
        this.settings.syncDirection ?? "bidirectional",
        profiler
      );
      console.info(`mixedEntityMappings:`);
      console.info(mixedEntityMappings); // for debugging
      profiler.insert("finish building full sync plan");
      await insertSyncPlanRecordByVault(
        this.db,
        mixedEntityMappings,
        this.vaultRandomID,
        client.serviceType
      );

      profiler.insert("finish writing sync plan");
      profiler.insert("finish step6 (plan)");

      // The operations above are almost read only and kind of safe.
      // The operations below begins to write or delete (!!!) something.

      if (triggerSource !== "dry") {
        if (this.settings.currLogLevel === "info") {
          // pass
        } else {
          getNotice(t("syncrun_step7"));
        }
        this.syncStatus = "syncing";
        await doActualSync(
          mixedEntityMappings,
          client,
          this.vaultRandomID,
          profileID,
          this.app.vault,
          cipher,
          this.settings.concurrency ?? 5,
          (key: string) => self.trash(key),
          this.settings.protectModifyPercentage ?? 50,
          (
            protectModifyPercentage: number,
            realModifyDeleteCount: number,
            allFilesCount: number
          ) => {
            const percent = (
              (100 * realModifyDeleteCount) /
              allFilesCount
            ).toFixed(1);
            const res = t("syncrun_abort_protectmodifypercentage", {
              protectModifyPercentage,
              realModifyDeleteCount,
              allFilesCount,
              percent,
            });
            return res;
          },
          (
            realCounter: number,
            realTotalCount: number,
            pathName: string,
            decision: string
          ) =>
            self.setCurrSyncMsg(
              realCounter,
              realTotalCount,
              pathName,
              decision,
              triggerSource
            ),
          this.db,
          profiler
        );
      } else {
        this.syncStatus = "syncing";
        if (this.settings.currLogLevel === "info") {
          getNotice(t("syncrun_shortstep2skip"));
        } else {
          getNotice(t("syncrun_step7skip"));
        }
      }

      cipher.closeResources();

      profiler.insert("finish step7 (actual sync)");

      if (this.settings.currLogLevel === "info") {
        getNotice(t("syncrun_shortstep2"));
      } else {
        getNotice(t("syncrun_step8"));
      }

      this.syncStatus = "finish";
      this.syncStatus = "idle";

      profiler.insert("finish step8");

      const lastSuccessSyncMillis = Date.now();
      await upsertLastSuccessSyncTimeByVault(
        this.db,
        this.vaultRandomID,
        lastSuccessSyncMillis
      );

      if (this.syncRibbon !== undefined) {
        setIcon(this.syncRibbon, iconNameSyncWait);
        this.syncRibbon.setAttribute("aria-label", originLabel);
      }

      if (this.statusBarElement !== undefined) {
        this.updateLastSuccessSyncMsg(lastSuccessSyncMillis);
      }

      this.syncEvent?.trigger("SYNC_DONE");
      console.info(
        `${
          this.manifest.id
        }-${Date.now()}: finish sync, triggerSource=${triggerSource}`
      );
    } catch (error: any) {
      profiler.insert("start error branch");
      const msg = t("syncrun_abort", {
        manifestID: this.manifest.id,
        theDate: `${Date.now()}`,
        triggerSource: triggerSource,
        syncStatus: this.syncStatus,
      });
      console.error(msg);
      console.error(error);
      getNotice(msg, 10 * 1000);
      if (error instanceof AggregateError) {
        for (const e of error.errors) {
          getNotice(e.message, 10 * 1000);
        }
      } else {
        getNotice(error?.message ?? "error while sync", 10 * 1000);
      }
      this.syncStatus = "idle";
      if (this.syncRibbon !== undefined) {
        setIcon(this.syncRibbon, iconNameSyncWait);
        this.syncRibbon.setAttribute("aria-label", originLabel);
      }

      profiler.insert("finish error branch");
    }

    profiler.insert("finish syncRun");
    console.debug(profiler.toString());
    insertProfilerResultByVault(
      this.db,
      profiler.toString(),
      this.vaultRandomID,
      this.settings.serviceType
    );
    profiler.clear();
  }

  async onload() {
    console.info(`loading plugin ${this.manifest.id}`);

    const { iconSvgSyncWait, iconSvgSyncRunning, iconSvgLogs } = getIconSvg();

    addIcon(iconNameSyncWait, iconSvgSyncWait);
    addIcon(iconNameSyncRunning, iconSvgSyncRunning);
    addIcon(iconNameLogs, iconSvgLogs);

    this.oauth2Info = {
      verifier: "",
      helperModal: undefined,
      authDiv: undefined,
      revokeDiv: undefined,
      revokeAuthSetting: undefined,
    }; // init

    this.currSyncMsg = "";

    this.syncEvent = new Events();

    await this.loadSettings();

    // MUST after loadSettings and before prepareDB
    const profileID: string = this.getCurrProfileID();

    // lang should be load early, but after settings
    this.i18n = new I18n(this.settings.lang!, async (lang: LangTypeAndAuto) => {
      this.settings.lang = lang;
      await this.saveSettings();
    });
    const t = (x: TransItemType, vars?: any) => {
      return this.i18n.t(x, vars);
    };

    await this.checkIfOauthExpires();

    // MUST before prepareDB()
    // And, it's also possible to be an empty string,
    // which means the vaultRandomID is read from db later!
    const vaultRandomIDFromOldConfigFile =
      await this.getVaultRandomIDFromOldConfigFile();

    // no need to await this
    this.tryToAddIgnoreFile();

    const vaultBasePath = this.getVaultBasePath();

    try {
      await this.prepareDBAndVaultRandomID(
        vaultBasePath,
        vaultRandomIDFromOldConfigFile,
        profileID
      );
    } catch (err: any) {
      new Notice(
        err?.message ?? "error of prepareDBAndVaultRandomID",
        10 * 1000
      );
      throw err;
    }

    // must AFTER preparing DB
    this.enableAutoClearOutputToDBHistIfSet();

    // must AFTER preparing DB
    this.enableAutoClearSyncPlanHist();

    this.syncStatus = "idle";

    this.registerObsidianProtocolHandler(COMMAND_URI, async (inputParams) => {
      // console.debug(inputParams);
      const parsed = importQrCodeUri(inputParams, this.app.vault.getName());
      if (parsed.status === "error") {
        new Notice(parsed.message);
      } else {
        const copied = cloneDeep(parsed.result);
        // new Notice(JSON.stringify(copied))
        this.settings = Object.assign({}, this.settings, copied);
        this.saveSettings();
        new Notice(
          t("protocol_saveqr", {
            manifestName: this.manifest.name,
          })
        );
      }
    });

    this.registerObsidianProtocolHandler(
      COMMAND_CALLBACK,
      async (inputParams) => {
        new Notice(
          t("protocol_callbacknotsupported", {
            params: JSON.stringify(inputParams),
          })
        );
      }
    );

    this.registerObsidianProtocolHandler(
      COMMAND_CALLBACK_DROPBOX,
      async (inputParams) => {
        if (
          inputParams.code !== undefined &&
          this.oauth2Info?.verifier !== undefined
        ) {
          if (this.oauth2Info.helperModal !== undefined) {
            const k = this.oauth2Info.helperModal.contentEl;
            k.empty();

            t("protocol_dropbox_connecting")
              .split("\n")
              .forEach((val) => {
                k.createEl("p", {
                  text: val,
                });
              });
          } else {
            new Notice(t("protocol_dropbox_no_modal"));
            return;
          }

          let authRes = await sendAuthReqDropbox(
            this.settings.dropbox.clientID,
            this.oauth2Info.verifier,
            inputParams.code,
            async (e: any) => {
              new Notice(t("protocol_dropbox_connect_fail"));
              new Notice(`${e}`);
              throw e;
            }
          );

          const self = this;
          setConfigBySuccessfullAuthInplaceDropbox(
            this.settings.dropbox,
            authRes!,
            () => self.saveSettings()
          );

          const client = new RemoteClient(
            "dropbox",
            undefined,
            undefined,
            this.settings.dropbox,
            undefined,
            this.app.vault.getName(),
            () => self.saveSettings()
          );

          const username = await client.getUser();
          this.settings.dropbox.username = username;
          await this.saveSettings();

          new Notice(
            t("protocol_dropbox_connect_succ", {
              username: username,
            })
          );

          this.oauth2Info.verifier = ""; // reset it
          this.oauth2Info.helperModal?.close(); // close it
          this.oauth2Info.helperModal = undefined;

          this.oauth2Info.authDiv?.toggleClass(
            "dropbox-auth-button-hide",
            this.settings.dropbox.username !== ""
          );
          this.oauth2Info.authDiv = undefined;

          this.oauth2Info.revokeAuthSetting?.setDesc(
            t("protocol_dropbox_connect_succ_revoke", {
              username: this.settings.dropbox.username,
            })
          );
          this.oauth2Info.revokeAuthSetting = undefined;
          this.oauth2Info.revokeDiv?.toggleClass(
            "dropbox-revoke-auth-button-hide",
            this.settings.dropbox.username === ""
          );
          this.oauth2Info.revokeDiv = undefined;
        } else {
          new Notice(t("protocol_dropbox_connect_fail"));
          throw Error(
            t("protocol_dropbox_connect_unknown", {
              params: JSON.stringify(inputParams),
            })
          );
        }
      }
    );

    this.registerObsidianProtocolHandler(
      COMMAND_CALLBACK_ONEDRIVE,
      async (inputParams) => {
        if (
          inputParams.code !== undefined &&
          this.oauth2Info?.verifier !== undefined
        ) {
          if (this.oauth2Info.helperModal !== undefined) {
            const k = this.oauth2Info.helperModal.contentEl;
            k.empty();

            t("protocol_onedrive_connecting")
              .split("\n")
              .forEach((val) => {
                k.createEl("p", {
                  text: val,
                });
              });
          }

          let rsp = await sendAuthReqOnedrive(
            this.settings.onedrive.clientID,
            this.settings.onedrive.authority,
            inputParams.code,
            this.oauth2Info.verifier,
            async (e: any) => {
              new Notice(t("protocol_onedrive_connect_fail"));
              new Notice(`${e}`);
              return; // throw?
            }
          );

          if ((rsp as any).error !== undefined) {
            new Notice(`${JSON.stringify(rsp)}`);
            throw Error(`${JSON.stringify(rsp)}`);
          }

          const self = this;
          setConfigBySuccessfullAuthInplaceOnedrive(
            this.settings.onedrive,
            rsp as AccessCodeResponseSuccessfulType,
            () => self.saveSettings()
          );

          const client = new RemoteClient(
            "onedrive",
            undefined,
            undefined,
            undefined,
            this.settings.onedrive,
            this.app.vault.getName(),
            () => self.saveSettings()
          );
          this.settings.onedrive.username = await client.getUser();
          await this.saveSettings();

          this.oauth2Info.verifier = ""; // reset it
          this.oauth2Info.helperModal?.close(); // close it
          this.oauth2Info.helperModal = undefined;

          this.oauth2Info.authDiv?.toggleClass(
            "onedrive-auth-button-hide",
            this.settings.onedrive.username !== ""
          );
          this.oauth2Info.authDiv = undefined;

          this.oauth2Info.revokeAuthSetting?.setDesc(
            t("protocol_onedrive_connect_succ_revoke", {
              username: this.settings.onedrive.username,
            })
          );
          this.oauth2Info.revokeAuthSetting = undefined;
          this.oauth2Info.revokeDiv?.toggleClass(
            "onedrive-revoke-auth-button-hide",
            this.settings.onedrive.username === ""
          );
          this.oauth2Info.revokeDiv = undefined;
        } else {
          new Notice(t("protocol_onedrive_connect_fail"));
          throw Error(
            t("protocol_onedrive_connect_unknown", {
              params: JSON.stringify(inputParams),
            })
          );
        }
      }
    );

    this.syncRibbon = this.addRibbonIcon(
      iconNameSyncWait,
      `${this.manifest.name}`,
      async () => this.syncRun("manual")
    );

    this.enableMobileStatusBarIfSet();

    // Create Status Bar Item
    if (
      (!Platform.isMobile ||
        (Platform.isMobile && this.settings.enableMobileStatusBar)) &&
      this.settings.enableStatusBarInfo === true
    ) {
      const statusBarItem = this.addStatusBarItem();
      this.statusBarElement = statusBarItem.createEl("span");
      this.statusBarElement.setAttribute("data-tooltip-position", "top");

      this.updateLastSuccessSyncMsg(
        await getLastSuccessSyncTimeByVault(this.db, this.vaultRandomID)
      );
      // update statusbar text every 30 seconds
      this.registerInterval(
        window.setInterval(async () => {
          this.updateLastSuccessSyncMsg(
            await getLastSuccessSyncTimeByVault(this.db, this.vaultRandomID)
          );
        }, 1000 * 30)
      );
    }

    this.addCommand({
      id: "start-sync",
      name: t("command_startsync"),
      icon: iconNameSyncWait,
      callback: async () => {
        this.syncRun("manual");
      },
    });

    this.addCommand({
      id: "start-sync-dry-run",
      name: t("command_drynrun"),
      icon: iconNameSyncWait,
      callback: async () => {
        this.syncRun("dry");
      },
    });

    this.addCommand({
      id: "export-sync-plans-1",
      name: t("command_exportsyncplans_1"),
      icon: iconNameLogs,
      callback: async () => {
        await exportVaultSyncPlansToFiles(
          this.db,
          this.app.vault,
          this.vaultRandomID,
          1
        );
        new Notice(t("settings_syncplans_notice"));
      },
    });

    this.addCommand({
      id: "export-sync-plans-5",
      name: t("command_exportsyncplans_5"),
      icon: iconNameLogs,
      callback: async () => {
        await exportVaultSyncPlansToFiles(
          this.db,
          this.app.vault,
          this.vaultRandomID,
          5
        );
        new Notice(t("settings_syncplans_notice"));
      },
    });

    this.addCommand({
      id: "export-sync-plans-all",
      name: t("command_exportsyncplans_all"),
      icon: iconNameLogs,
      callback: async () => {
        await exportVaultSyncPlansToFiles(
          this.db,
          this.app.vault,
          this.vaultRandomID,
          -1
        );
        new Notice(t("settings_syncplans_notice"));
      },
    });

    this.addSettingTab(new RemotelySaveSettingTab(this.app, this));

    // this.registerDomEvent(document, "click", (evt: MouseEvent) => {
    //   console.info("click", evt);
    // });

    if (!this.settings.agreeToUseSyncV3) {
      const syncAlgoV3Modal = new SyncAlgoV3Modal(this.app, this);
      syncAlgoV3Modal.open();
    } else {
      this.enableAutoSyncIfSet();
      this.enableInitSyncIfSet();
      this.enableSyncOnSaveIfSet();
    }

    // compare versions and read new versions
    const { oldVersion } = await upsertPluginVersionByVault(
      this.db,
      this.vaultRandomID,
      this.manifest.version
    );
  }

  async onunload() {
    console.info(`unloading plugin ${this.manifest.id}`);
    this.syncRibbon = undefined;
    if (this.appContainerObserver !== undefined) {
      this.appContainerObserver.disconnect();
      this.appContainerObserver = undefined;
    }
    if (this.oauth2Info !== undefined) {
      this.oauth2Info.helperModal = undefined;
      this.oauth2Info = {
        verifier: "",
        helperModal: undefined,
        authDiv: undefined,
        revokeDiv: undefined,
        revokeAuthSetting: undefined,
      };
    }
  }

  async loadSettings() {
    this.settings = Object.assign(
      {},
      cloneDeep(DEFAULT_SETTINGS),
      messyConfigToNormal(await this.loadData())
    );
    if (this.settings.dropbox.clientID === "") {
      this.settings.dropbox.clientID = DEFAULT_SETTINGS.dropbox.clientID;
    }
    if (this.settings.dropbox.remoteBaseDir === undefined) {
      this.settings.dropbox.remoteBaseDir = "";
    }
    if (this.settings.onedrive.clientID === "") {
      this.settings.onedrive.clientID = DEFAULT_SETTINGS.onedrive.clientID;
    }
    if (this.settings.onedrive.authority === "") {
      this.settings.onedrive.authority = DEFAULT_SETTINGS.onedrive.authority;
    }
    if (this.settings.onedrive.remoteBaseDir === undefined) {
      this.settings.onedrive.remoteBaseDir = "";
    }
    if (this.settings.webdav.manualRecursive === undefined) {
      this.settings.webdav.manualRecursive = true;
    }
    if (
      this.settings.webdav.depth === undefined ||
      this.settings.webdav.depth === "auto" ||
      this.settings.webdav.depth === "auto_1" ||
      this.settings.webdav.depth === "auto_infinity" ||
      this.settings.webdav.depth === "auto_unknown"
    ) {
      // auto is deprecated as of 20240116
      this.settings.webdav.depth = "manual_1";
      this.settings.webdav.manualRecursive = true;
    }
    if (this.settings.webdav.remoteBaseDir === undefined) {
      this.settings.webdav.remoteBaseDir = "";
    }
    if (this.settings.s3.partsConcurrency === undefined) {
      this.settings.s3.partsConcurrency = 20;
    }
    if (this.settings.s3.forcePathStyle === undefined) {
      this.settings.s3.forcePathStyle = false;
    }
    if (this.settings.s3.remotePrefix === undefined) {
      this.settings.s3.remotePrefix = "";
    }
    if (this.settings.s3.useAccurateMTime === undefined) {
      // it causes money, so disable it by default
      this.settings.s3.useAccurateMTime = false;
    }
    if (this.settings.ignorePaths === undefined) {
      this.settings.ignorePaths = [];
    }
    if (this.settings.enableStatusBarInfo === undefined) {
      this.settings.enableStatusBarInfo = true;
    }
    if (this.settings.syncOnSaveAfterMilliseconds === undefined) {
      this.settings.syncOnSaveAfterMilliseconds = -1;
    }
    if (this.settings.deleteToWhere === undefined) {
      this.settings.deleteToWhere = "system";
    }
    this.settings.logToDB = false; // deprecated as of 20240113

    if (requireApiVersion(API_VER_ENSURE_REQURL_OK)) {
      this.settings.s3.bypassCorsLocally = true; // deprecated as of 20240113
    }

    if (this.settings.agreeToUseSyncV3 === undefined) {
      this.settings.agreeToUseSyncV3 = false;
    }
    if (this.settings.conflictAction === undefined) {
      this.settings.conflictAction = "keep_newer";
    }
    if (this.settings.howToCleanEmptyFolder === undefined) {
      this.settings.howToCleanEmptyFolder = "skip";
    }
    if (this.settings.protectModifyPercentage === undefined) {
      this.settings.protectModifyPercentage = 50;
    }
    if (this.settings.syncDirection === undefined) {
      this.settings.syncDirection = "bidirectional";
    }

    if (this.settings.obfuscateSettingFile === undefined) {
      this.settings.obfuscateSettingFile = true;
    }

    if (this.settings.enableMobileStatusBar === undefined) {
      this.settings.enableMobileStatusBar = false;
    }

    if (
      this.settings.encryptionMethod === undefined ||
      this.settings.encryptionMethod === "unknown"
    ) {
      if (
        this.settings.password === undefined ||
        this.settings.password === ""
      ) {
        // we have a preferred way
        this.settings.encryptionMethod = "rclone-base64";
      } else {
        // likely to be inherited from the old version
        this.settings.encryptionMethod = "openssl-base64";
      }
    }

    await this.saveSettings();
  }

  async saveSettings() {
    if (this.settings.obfuscateSettingFile) {
      await this.saveData(normalConfigToMessy(this.settings));
    } else {
      await this.saveData(this.settings);
    }
  }

  /**
   * After 202403 the data should be of profile based.
   */
  getCurrProfileID() {
    if (this.settings.serviceType !== undefined) {
      return `${this.settings.serviceType}-default-1`;
    } else {
      throw Error("unknown serviceType in the setting!");
    }
  }

  async checkIfOauthExpires() {
    let needSave: boolean = false;
    const current = Date.now();

    // fullfill old version settings
    if (
      this.settings.dropbox.refreshToken !== "" &&
      this.settings.dropbox.credentialsShouldBeDeletedAtTime === undefined
    ) {
      // It has a refreshToken, but not expire time.
      // Likely to be a setting from old version.
      // we set it to a month.
      this.settings.dropbox.credentialsShouldBeDeletedAtTime =
        current + 1000 * 60 * 60 * 24 * 30;
      needSave = true;
    }
    if (
      this.settings.onedrive.refreshToken !== "" &&
      this.settings.onedrive.credentialsShouldBeDeletedAtTime === undefined
    ) {
      this.settings.onedrive.credentialsShouldBeDeletedAtTime =
        current + 1000 * 60 * 60 * 24 * 30;
      needSave = true;
    }

    // check expired or not
    let dropboxExpired = false;
    if (
      this.settings.dropbox.refreshToken !== "" &&
      current >= this.settings!.dropbox!.credentialsShouldBeDeletedAtTime!
    ) {
      dropboxExpired = true;
      this.settings.dropbox = cloneDeep(DEFAULT_DROPBOX_CONFIG);
      needSave = true;
    }

    let onedriveExpired = false;
    if (
      this.settings.onedrive.refreshToken !== "" &&
      current >= this.settings!.onedrive!.credentialsShouldBeDeletedAtTime!
    ) {
      onedriveExpired = true;
      this.settings.onedrive = cloneDeep(DEFAULT_ONEDRIVE_CONFIG);
      needSave = true;
    }

    // save back
    if (needSave) {
      await this.saveSettings();
    }

    // send notice
    if (dropboxExpired && onedriveExpired) {
      new Notice(
        `${this.manifest.name}: You haven't manually auth Dropbox and OneDrive for a while, you need to re-auth them again.`,
        6000
      );
    } else if (dropboxExpired) {
      new Notice(
        `${this.manifest.name}: You haven't manually auth Dropbox for a while, you need to re-auth it again.`,
        6000
      );
    } else if (onedriveExpired) {
      new Notice(
        `${this.manifest.name}: You haven't manually auth OneDrive for a while, you need to re-auth it again.`,
        6000
      );
    }
  }

  async getVaultRandomIDFromOldConfigFile() {
    let vaultRandomID = "";
    if (this.settings.vaultRandomID !== undefined) {
      // In old version, the vault id is saved in data.json
      // But we want to store it in localForage later
      if (this.settings.vaultRandomID !== "") {
        // a real string was assigned before
        vaultRandomID = this.settings.vaultRandomID;
      }
      console.debug("vaultRandomID is no longer saved in data.json");
      delete this.settings.vaultRandomID;
      await this.saveSettings();
    }
    return vaultRandomID;
  }

  async trash(x: string) {
    if (this.settings.deleteToWhere === "obsidian") {
      await this.app.vault.adapter.trashLocal(x);
    } else {
      // "system"
      if (!(await this.app.vault.adapter.trashSystem(x))) {
        await this.app.vault.adapter.trashLocal(x);
      }
    }
  }

  getVaultBasePath() {
    if (this.app.vault.adapter instanceof FileSystemAdapter) {
      // in desktop
      return this.app.vault.adapter.getBasePath().split("?")[0];
    } else {
      // in mobile
      return this.app.vault.adapter.getResourcePath("").split("?")[0];
    }
  }

  async prepareDBAndVaultRandomID(
    vaultBasePath: string,
    vaultRandomIDFromOldConfigFile: string,
    profileID: string
  ) {
    const { db, vaultRandomID } = await prepareDBs(
      vaultBasePath,
      vaultRandomIDFromOldConfigFile,
      profileID
    );
    this.db = db;
    this.vaultRandomID = vaultRandomID;
  }

  enableAutoSyncIfSet() {
    if (
      this.settings.autoRunEveryMilliseconds !== undefined &&
      this.settings.autoRunEveryMilliseconds !== null &&
      this.settings.autoRunEveryMilliseconds > 0
    ) {
      this.app.workspace.onLayoutReady(() => {
        const intervalID = window.setInterval(() => {
          this.syncRun("auto");
        }, this.settings.autoRunEveryMilliseconds);
        this.autoRunIntervalID = intervalID;
        this.registerInterval(intervalID);
      });
    }
  }

  enableInitSyncIfSet() {
    if (
      this.settings.initRunAfterMilliseconds !== undefined &&
      this.settings.initRunAfterMilliseconds !== null &&
      this.settings.initRunAfterMilliseconds > 0
    ) {
      this.app.workspace.onLayoutReady(() => {
        window.setTimeout(() => {
          this.syncRun("auto_once_init");
        }, this.settings.initRunAfterMilliseconds);
      });
    }
  }

  enableSyncOnSaveIfSet() {
    if (
      this.settings.syncOnSaveAfterMilliseconds !== undefined &&
      this.settings.syncOnSaveAfterMilliseconds !== null &&
      this.settings.syncOnSaveAfterMilliseconds > 0
    ) {
      let runScheduled = false;
      let needToRunAgain = false;

      const scheduleSyncOnSave = (scheduleTimeFromNow: number) => {
        console.info(
          `schedule a run for ${scheduleTimeFromNow} milliseconds later`
        );
        runScheduled = true;
        setTimeout(() => {
          this.syncRun("auto_sync_on_save");
          runScheduled = false;
        }, scheduleTimeFromNow);
      };

      const checkCurrFileModified = async (caller: "SYNC" | "FILE_CHANGES") => {
        const currentFile = this.app.workspace.getActiveFile();

        if (currentFile) {
          // get the last modified time of the current file
          // if it has modified after lastSuccessSync
          // then schedule a run for syncOnSaveAfterMilliseconds after it was modified
          const lastModified = currentFile.stat.mtime;
          const lastSuccessSyncMillis = await getLastSuccessSyncTimeByVault(
            this.db,
            this.vaultRandomID
          );
          if (
            this.syncStatus === "idle" &&
            lastModified > lastSuccessSyncMillis &&
            !runScheduled
          ) {
            scheduleSyncOnSave(this.settings!.syncOnSaveAfterMilliseconds!);
          } else if (
            this.syncStatus === "idle" &&
            needToRunAgain &&
            !runScheduled
          ) {
            scheduleSyncOnSave(this.settings!.syncOnSaveAfterMilliseconds!);
            needToRunAgain = false;
          } else {
            if (caller === "FILE_CHANGES") {
              needToRunAgain = true;
            }
          }
        }
      };

      this.app.workspace.onLayoutReady(() => {
        // listen to sync done
        this.registerEvent(
          this.syncEvent?.on("SYNC_DONE", () => {
            checkCurrFileModified("SYNC");
          })!
        );

        // listen to current file save changes
        this.registerEvent(
          this.app.vault.on("modify", (x) => {
            // console.debug(`event=modify! file=${x}`);
            checkCurrFileModified("FILE_CHANGES");
          })
        );
      });
    }
  }

  enableMobileStatusBarIfSet() {
    this.app.workspace.onLayoutReady(() => {
      if (Platform.isMobile && this.settings.enableMobileStatusBar) {
        this.appContainerObserver = changeMobileStatusBar("enable");
      }
    });
  }

  async saveAgreeToUseNewSyncAlgorithm() {
    this.settings.agreeToUseSyncV3 = true;
    await this.saveSettings();
  }

  async setCurrSyncMsg(
    i: number,
    totalCount: number,
    pathName: string,
    decision: string,
    triggerSource: SyncTriggerSourceType
  ) {
    const msg = `syncing progress=${i}/${totalCount},decision=${decision},path=${pathName},source=${triggerSource}`;
    this.currSyncMsg = msg;
  }

  updateLastSuccessSyncMsg(lastSuccessSyncMillis?: number) {
    if (this.statusBarElement === undefined) return;

    const t = (x: TransItemType, vars?: any) => {
      return this.i18n.t(x, vars);
    };

    let lastSyncMsg = t("statusbar_lastsync_never");
    let lastSyncLabelMsg = t("statusbar_lastsync_never_label");

    if (lastSuccessSyncMillis !== undefined && lastSuccessSyncMillis === -1) {
      lastSyncMsg = t("statusbar_syncing");
    }

    if (lastSuccessSyncMillis !== undefined && lastSuccessSyncMillis > 0) {
      const deltaTime = Date.now() - lastSuccessSyncMillis;

      // create human readable time
      const years = Math.floor(deltaTime / 31556952000);
      const months = Math.floor(deltaTime / 2629746000);
      const weeks = Math.floor(deltaTime / 604800000);
      const days = Math.floor(deltaTime / 86400000);
      const hours = Math.floor(deltaTime / 3600000);
      const minutes = Math.floor(deltaTime / 60000);
      const seconds = Math.floor(deltaTime / 1000);

      let timeText = "";

      if (years > 0) {
        timeText = t("statusbar_time_years", { time: years });
      } else if (months > 0) {
        timeText = t("statusbar_time_months", { time: months });
      } else if (weeks > 0) {
        timeText = t("statusbar_time_weeks", { time: weeks });
      } else if (days > 0) {
        timeText = t("statusbar_time_days", { time: days });
      } else if (hours > 0) {
        timeText = t("statusbar_time_hours", { time: hours });
      } else if (minutes > 0) {
        timeText = t("statusbar_time_minutes", { time: minutes });
      } else if (seconds > 30) {
        timeText = t("statusbar_time_lessminute");
      } else {
        timeText = t("statusbar_now");
      }

      let dateText = new Date(lastSuccessSyncMillis).toLocaleTimeString(
        navigator.language,
        {
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
        }
      );

      lastSyncMsg = timeText;
      lastSyncLabelMsg = t("statusbar_lastsync_label", { date: dateText });
    }

    this.statusBarElement.setText(lastSyncMsg);
    this.statusBarElement.setAttribute("aria-label", lastSyncLabelMsg);
  }

  /**
   * Because data.json contains sensitive information,
   * We usually want to ignore it in the version control.
   * However, if there's already a an ignore file (even empty),
   * we respect the existing configure and not add any modifications.
   * @returns
   */
  async tryToAddIgnoreFile() {
    const pluginConfigDir =
      this.manifest.dir ||
      `${this.app.vault.configDir}/plugins/${this.manifest.dir}`;
    const pluginConfigDirExists =
      await this.app.vault.adapter.exists(pluginConfigDir);
    if (!pluginConfigDirExists) {
      // what happened?
      return;
    }
    const ignoreFile = `${pluginConfigDir}/.gitignore`;
    const ignoreFileExists = await this.app.vault.adapter.exists(ignoreFile);

    const contentText = "data.json\n";

    try {
      if (!ignoreFileExists) {
        // not exists, directly create
        // no need to await
        this.app.vault.adapter.write(ignoreFile, contentText);
      }
    } catch (error) {
      // just skip
    }
  }

  enableAutoClearOutputToDBHistIfSet() {
    const initClearOutputToDBHistAfterMilliseconds = 1000 * 30;

    this.app.workspace.onLayoutReady(() => {
      // init run
      window.setTimeout(() => {
        clearAllLoggerOutputRecords(this.db);
      }, initClearOutputToDBHistAfterMilliseconds);
    });
  }

  enableAutoClearSyncPlanHist() {
    const initClearSyncPlanHistAfterMilliseconds = 1000 * 45;
    const autoClearSyncPlanHistAfterMilliseconds = 1000 * 60 * 5;

    this.app.workspace.onLayoutReady(() => {
      // init run
      window.setTimeout(() => {
        clearExpiredSyncPlanRecords(this.db);
      }, initClearSyncPlanHistAfterMilliseconds);

      // scheduled run
      const intervalID = window.setInterval(() => {
        clearExpiredSyncPlanRecords(this.db);
      }, autoClearSyncPlanHistAfterMilliseconds);
      this.registerInterval(intervalID);
    });
  }
}
