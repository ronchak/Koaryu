import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
// Mount the real provider and action hooks in Chromium. Only external I/O is replaced.
// A tiny CommonJS packer avoids adding a second frontend build or test runtime.
const require = createRequire(import.meta.url);
const frontend = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export function bundle(
  mode,
  {
    preview = false,
    pagedRoster = true,
    layout = false,
    leadsPage = false,
    leadController = false,
    programsSection = false,
    staffSection = false,
    subscriptionPage = false,
    scheduleController = false,
    scheduleForm = false,
    dashboardController = false,
    beltPage = false,
    realApi = false,
    detailController = false,
    rosterController = false,
    studentForm = false,
    legacyBootstrapFixture = false,
    operationsComponents = false,
    rosterPresentation = false,
  } = {},
) {
  if (!["production", "development"].includes(mode) || typeof preview !== "boolean")
    throw new Error("Unsupported fixture environment");
  const modules = [];
  const ids = new Map();
  const stubs = {
    "next/navigation": `const subscribe=cb=>{window.addEventListener('fixture:navigate',cb);return ()=>window.removeEventListener('fixture:navigate',cb)};const pathname=()=>window.fixture.pathname??'/dashboard';exports.usePathname=()=>require('react').useSyncExternalStore(subscribe,pathname,pathname); exports.useParams=()=>({id:window.fixture.studentId??'student-1'}); exports.useSearchParams=()=>new URLSearchParams(window.fixture.search??window.location.search); const router={replace(path){(window.fixture.redirects??=[]).push(path)},push(path){(window.fixture.redirects??=[]).push(path)}}; exports.useRouter=()=>router;`,
    "@/lib/supabase/client": `exports.createClient=()=>window.fixture.supabase;`,
    "@/lib/api": `class ApiError extends Error { constructor(message,status,detail){super(message);this.status=status;this.detail=detail;} } exports.ApiError=ApiError; exports.CommandOutcomeUnknown=require("@/lib/command-outcome").CommandOutcomeUnknown;window.fixture.CommandOutcomeUnknown=exports.CommandOutcomeUnknown;exports.api=window.fixture.api; exports.isSubscriptionRequiredError=e=>e.status===402; exports.isStaffArchivedError=e=>e.status===403&&/archived/i.test(e.message);`,
    "@/lib/performance": `exports.markPerformance=name=>{window.fixture.marks?.push(name);window.fixture.timingMarks?.push({name,atMs:performance.now()});};exports.measurePerformance=()=>{};exports.startStudentPagePerformanceSpan=()=>({finish(){}});exports.markDashboardReadiness=(route,generation,state)=>{window.fixture.readiness?.push(state);return ()=>{};};`,
    ...(operationsComponents
      ? {
          "@/lib/store": `exports.useStudioStore=()=>window.fixture.studioStore;exports.useProgramStore=()=>window.fixture.programStore;`,
          "./sliding-segmented-control.module.css": `module.exports={};`,
          "lucide-react": `module.exports=new Proxy({},{get:()=>()=>null});`,
        }
      : {}),
    ...(rosterPresentation
      ? {
          "next/dynamic": `exports.__esModule=true;exports.default=()=>()=>null;`,
          "next/link": `exports.__esModule=true;exports.default=({children,href,prefetch,...props})=>require('react').createElement('a',{href:typeof href==='string'?href:href.pathname,...props},children);`,
          "@/components/icons/martial-arts-belt": `exports.MartialArtsBelt=()=>null;`,
          "@/components/header": `exports.Header=({title,description})=>require('react').createElement('header',null,title,description);`,
          "@/components/programs/program-picker": `exports.ProgramBadge=({program,name})=>require('react').createElement('span',null,program?.name??name);`,
          "@/components/students/status-badge": `exports.StatusBadge=({status})=>require('react').createElement('span',null,status);`,
          "@/components/students/student-avatar": `exports.StudentAvatar=()=>null;`,
          "./belt-tracker.module.css": `exports.__esModule=true;exports.default=new Proxy({},{get:(_target,name)=>String(name)});`,
          "./leads-ledger.module.css": `exports.__esModule=true;exports.default=new Proxy({},{get:(_target,name)=>String(name)});`,
          "./records-loading.module.css": `exports.__esModule=true;exports.default=new Proxy({},{get:(_target,name)=>String(name)});`,
          "./sliding-segmented-control.module.css": `exports.__esModule=true;exports.default=new Proxy({},{get:(_target,name)=>String(name)});`,
          "./student-records.module.css": `exports.__esModule=true;exports.default=new Proxy({},{get:(_target,name)=>String(name)});`,
          "lucide-react": `module.exports=new Proxy({},{get:()=>()=>null});`,
        }
      : {}),
    ...(scheduleForm
      ? {
          "@/components/schedule/schedule-page-section": `exports.SchedulePageSection=()=>null;`,
          "@/components/schedule/session-detail-modal": `exports.ScheduleSessionDetailModal=()=>null;`,
          "@/components/operations/operations-surface": `exports.OperationsSurface=({children})=>children;`,
        }
      : {}),
    ...(leadsPage
      ? {
          "@/components/header": `exports.Header=()=>null;`,
          "@/components/leads/lead-ledger-loading": `exports.LeadLedgerLoading=()=>null;`,
          "@/components/leads/add-lead-modal": `exports.AddLeadModal=()=>null;`,
          "@/components/leads/lead-detail-modal": `exports.LeadDetailInspector=()=>null;`,
          "@/components/leads/lead-pipeline-board": `exports.LeadPipelineBoard=()=>null;exports.LeadLedgerLoadError=()=>null;`,
          "@/components/leads/lost-leads-section": `exports.LostLeadsSection=()=>null;`,
          "@/components/leads/leads-ledger.module.css": `module.exports={};`,
          "@/components/ui/button": `exports.Button=({children,onClick})=>require('react').createElement('button',{onClick},children);`,
          "@/components/ui/dismissible-notice": `exports.DismissibleNotice=({children})=>children;`,
          "lucide-react": `exports.UserPlus=()=>null;`,
        }
      : {}),
    ...(staffSection
      ? {
          "lucide-react": `module.exports=new Proxy({},{get:()=>()=>null});`,
        }
      : {}),
    ...(programsSection
      ? {
          "@/components/ui/input": `exports.Input=()=>null;`,
          "@/components/ui/button": `exports.Button=({children,onClick})=>require('react').createElement('button',{onClick},children);`,
          "@/components/ui/dismissible-notice": `exports.DismissibleNotice=({children})=>children;`,
          "lucide-react": `for (const name of ['Archive','Check','Plus','RefreshCw','RotateCcw','Save','Settings2','UserPlus']) exports[name]=()=>null;`,
        }
      : {}),
    ...(subscriptionPage || realApi
      ? {
          "@/components/header": `exports.Header=()=>null;`,
          "@/components/operations/operations-surface": `exports.OperationsSurface=({children})=>require('react').createElement('section',{'data-recovery-page':'true'},children);`,
          "@/components/ui/button": `exports.Button=({children,onClick,disabled})=>require('react').createElement('button',{onClick,disabled},children);`,
          "@/components/logo": `exports.Logo=()=>null;`,
          "@/components/dashboard-loading-skeleton": `exports.DashboardLoadingSkeleton=()=>require('react').createElement('div',{'data-preview-gate':'pending'});`,
          "./dashboard-shell.module.css": `module.exports={};`,
          "lucide-react": `for (const name of ['ArrowUpRight','CheckCircle2','CreditCard','Loader2','ShieldCheck']) exports[name]=()=>null;`,
        }
      : {}),
    ...(beltPage === "editor"
      ? {
          "@/components/header": `exports.Header=()=>null;`,
          "@/components/belt-tracker/eligibility-panel": `exports.EligibilityPanel=()=>null;`,
          "@/components/icons/martial-arts-belt": `exports.MartialArtsBelt=()=>null;`,
          "./belt-tracker.module.css": `module.exports={};`,
          "./sliding-segmented-control.module.css": `module.exports={};`,
          "lucide-react": `module.exports=new Proxy({},{get:()=>()=>null});`,
        }
      : beltPage
        ? {
            "@/components/belt-tracker/belt-tracker-dialogs": `exports.BeltTrackerDialogs=()=>null;`,
            "@/components/belt-tracker/belt-tracker-shell": `exports.BeltTrackerShell=({children})=>children;`,
            "@/components/belt-tracker/eligibility-panel": `exports.EligibilityPanel=()=>null;`,
            "@/components/belt-tracker/rank-plan-panel": `exports.RankPlanPanel=()=>null;`,
            "@/lib/belt-tracker-page-controller": `exports.useBeltTrackerPageController=()=>({shellProps:{},eligibilityPanelProps:{},rankPlanPanelProps:{},dialogsProps:{},tab:'eligibility'});`,
          }
        : {}),
    ...(preview || layout
      ? {
          "@/components/dashboard-shell.module.css": `module.exports={};`,
          "@/components/theme-provider": `exports.useTheme=()=>({navigationPlacement:'side'});`,
          "@/components/dashboard-route-transition": `exports.DashboardRouteTransition=({children})=>children;`,
          "@/components/dashboard-shell": `exports.DashboardSlugBand=()=>null;`,
          "@/components/dashboard-shell-readiness": `exports.DashboardShellReadiness=({identityReady})=>{window.fixture.store=require("@/lib/store").useStore();window.fixture.identityObservations.push(identityReady);return null;};`,
          ...(subscriptionPage || realApi
            ? {}
            : {
                "@/components/dashboard-identity-skeleton": `exports.DashboardIdentitySkeleton=()=>require('react').createElement('div',{'data-preview-gate':'pending'});`,
              }),
          "@/components/account/legal-name-blocking-screen": `exports.LegalNameBlockingScreen=()=>require('react').createElement('div',{'data-preview-gate':'legal-name'});`,
          "@/components/sidebar": `exports.Sidebar=()=>require('react').createElement('nav',{'data-preview-sidebar':'ready'});`,
        }
      : {}),
  };
  if (realApi) delete stubs["@/lib/api"];
  function add(specifier, parent = resolve(frontend, "entry.js")) {
    let key = specifier;
    if (!(key in stubs)) {
      if (specifier.startsWith("@/")) key = resolve(frontend, "src", specifier.slice(2));
      else if (specifier.startsWith(".")) key = resolve(dirname(parent), specifier);
      else key = require.resolve(specifier, { paths: [dirname(parent), frontend] });
      if (!existsSync(key)) key = [".ts", ".tsx", ".js"].map((ext) => key + ext).find(existsSync);
      if (!key) throw new Error(`Cannot resolve ${specifier} from ${parent}`);
    }
    if (ids.has(key)) return ids.get(key);
    const id = modules.length;
    ids.set(key, id);
    modules.push("");
    let source = stubs[key] ?? readFileSync(key, "utf8");
    const needsCommonJsTranspile =
      /\.tsx?$/.test(key) || (/\.m?js$/.test(key) && /^(?:import|export)\b/m.test(source));
    if (needsCommonJsTranspile)
      source = ts.transpileModule(source, {
        fileName: key,
        compilerOptions: {
          jsx: ts.JsxEmit.ReactJSX,
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
          esModuleInterop: true,
        },
      }).outputText;
    source = source.replace(
      /require\(["']([^"']+)["']\)/g,
      (_, dependency) => `require(${add(dependency, key)})`,
    );
    modules[id] = `function(module,exports,require){${source}\n}`;
    return id;
  }
  if (operationsComponents) {
    const react = add("react");
    const dom = add("react-dom/client");
    const schedule = add("@/components/schedule/schedule-page-section");
    const programs = add("@/components/settings/programs-section");
    return `(()=>{const process={env:{NODE_ENV:"production"}};const modules=[${modules.join(",")}],cache={};function require(id){if(cache[id])return cache[id].exports;const module=cache[id]={exports:{}};modules[id](module,module.exports,require);return module.exports;}const React=require(${react});const root=require(${dom}).createRoot(document.getElementById('root'));const SchedulePageSection=require(${schedule}).SchedulePageSection;const ProgramsSection=require(${programs}).ProgramsSection;const noop=()=>{};window.fixture.renderSchedule=props=>root.render(React.createElement(SchedulePageSection,{onRetryRange:noop,onNavigate:noop,onJumpToToday:noop,onViewChange:noop,onProgramFilterChange:noop,onDismissScheduleLoadError:noop,onDismissActionMessage:noop,onSelectDate:noop,onOpenAddClass:noop,...props,currentDate:new Date(props.currentDate),onOpenSession:session=>window.fixture.opened.push(session.id)}));window.fixture.renderPrograms=()=>root.render(React.createElement(ProgramsSection));})();`;
  }
  if (rosterPresentation) {
    const react = add("react");
    const dom = add("react-dom/client");
    const page = add("@/components/students/student-roster-page-content");
    const eligibility = add("@/components/belt-tracker/eligibility-panel");
    const mapping = add("@/components/students/student-import-mapping-step");
    const session = add("@/components/schedule/session-detail-modal");
    const sidebar = add("@/components/students/student-detail-sidebar");
    const leadPipeline = add("@/components/leads/lead-pipeline-board");
    const recordsLoading = add("@/components/records/records-loading");
    const segmentedControl = add("@/components/ui/sliding-segmented-control");
    const studentBadge = add("@/components/students/student-rank-badge");
    const rankVisuals = add("@/components/belt-tracker/rank-visuals");
    return `(()=>{const process={env:{NODE_ENV:"production"}};const modules=[${modules.join(",")}],cache={};function require(id){if(cache[id])return cache[id].exports;const module=cache[id]={exports:{}};modules[id](module,module.exports,require);return module.exports;}const React=require(${react});const root=require(${dom}).createRoot(document.getElementById('root'));const Page=require(${page}).StudentRosterPageContent;const StudentBadge=require(${studentBadge}).StudentRankBadge;const RankBadge=require(${rankVisuals}).RankBadge;const noop=()=>{};window.fixture.renderRoster=input=>root.render(React.createElement(Page,{actionMessage:null,activeBulkPanel:null,activeLoadError:null,allSelected:false,bulkActionError:null,bulkStatus:'active',canCreateStudents:false,canManageRoster:true,deleteError:null,filtered:input.filtered,fullRosterRequested:false,hasActiveFilters:false,hasNextPage:false,hasNewStudentFilter:false,hasPreviousPage:false,inactivityByStudentId:new Map(),inactivityThreshold:null,isAdding:false,isAddingTags:false,isDeleting:false,isInitialRosterLoading:false,isNewStudentYtd:false,isPagedLoading:false,isRosterRefreshing:false,isUpdatingStatus:false,newStudentDays:null,newStudentStartDate:null,onAddStudent:noop,onAddStudentSubmit:async()=>{},onAddTags:async()=>{},onBulkStatusChange:noop,onBulkStatusUpdate:async()=>{},onCancelDelete:noop,onCancelStatus:noop,onCancelTags:noop,onClearFilters:noop,onCloseStudentForm:noop,onDeleteSelected:async()=>{},onDismissActionMessage:noop,onDismissRosterQueryNotice:noop,onImportCsv:noop,onNextPage:noop,onOpenStudent:id=>window.fixture.opened.push(id),onPreviousPage:noop,onProgramFilterChange:noop,onRetryRosterLoad:noop,onSearchChange:noop,onSort:key=>window.fixture.sorts.push(key),onStatusFilterChange:noop,onTagInputChange:noop,onToggleBulkPanel:noop,onToggleSelect:id=>window.fixture.selected.push(id),onToggleSelectAll:noop,page:1,pageEnd:2,pageStart:1,pagedTotal:2,programFilter:'',programs:[],search:'',selectedCount:0,selectedIds:new Set(),showForm:false,sortDir:input.sortDir??'asc',sortKey:input.sortKey??'name',statusFilter:'',studentsCount:2,tagInput:'',totalPages:1,usesDerivedRosterFilters:false,visibleTotal:2}));window.fixture.renderBadges=()=>root.render(React.createElement('div',null,React.createElement(StudentBadge,{name:'Student yellow tip',colorHex:'#EAB308',isTip:true,tipColorHex:'#22C55E'}),React.createElement(RankBadge,{name:'Belt yellow tip',color:'#EAB308',isTip:true,tipColor:'#22C55E'})));
const Eligibility = require(${eligibility}).EligibilityPanel;
const Mapping = require(${mapping}).StudentImportMappingStep;
const Session = require(${session}).ScheduleSessionDetailModal;
const Sidebar = require(${sidebar}).StudentDetailSidebar;
const LeadLedgerLoadError = require(${leadPipeline}).LeadLedgerLoadError;
const RecordsLoading = require(${recordsLoading}).RecordsLoading;
const SlidingSegmentedControl = require(${segmentedControl}).SlidingSegmentedControl;
const ProgressBar = require(${rankVisuals}).ProgressBar;

window.fixture.renderEligibility = (props) => {
  root.render(React.createElement(Eligibility, props));
};

window.fixture.renderSession = (props) => {
  root.render(React.createElement(Session, props));
};

window.fixture.renderSidebar = (props) => {
  root.render(React.createElement(Sidebar, props));
};

window.fixture.renderMappings = (instances) => {
  root.render(
    React.createElement(
      React.Fragment,
      null,
      ...instances.map((props, index) =>
        React.createElement(Mapping, { ...props, key: index }),
      ),
    ),
  );
};

window.fixture.renderSegmentedControl = (props) => {
  root.render(React.createElement(SlidingSegmentedControl, props));
};

window.fixture.renderProgressBars = (instances) => {
  root.render(
    React.createElement(
      React.Fragment,
      null,
      ...instances.map((props, index) =>
        React.createElement(ProgressBar, { ...props, key: index }),
      ),
    ),
  );
};

window.fixture.renderLeadLedgerLoadError = (props) => {
  root.render(React.createElement(LeadLedgerLoadError, props));
};

window.fixture.renderRecordsLoading = (props) => {
  root.render(React.createElement(RecordsLoading, props));
};
})();`;
  }
  const react = add("react");
  const dom = add("react-dom/client");
  const store = add("@/lib/store");
  const pendingCommands = add("@/lib/pending-commands");
  const leads = leadsPage ? add("@/app/(dashboard)/leads/page") : null;
  const programs = programsSection ? add("@/components/settings/programs-section") : null;
  const staff = staffSection ? add("@/components/settings/staff-roles-section") : null;
  const subscription = subscriptionPage
    ? add("@/app/(dashboard)/subscription-required/page")
    : null;
  const schedule = scheduleController ? add("@/lib/schedule-page-controller") : null;
  const scheduleContent = scheduleForm ? add("@/components/schedule/schedule-page-content") : null;
  const scheduleObserver =
    schedule === null
      ? ""
      : `function ScheduleObserver(){const store=useStore();const controller=require(${schedule}).useSchedulePageController({config:store,programsStore:store,scheduleStore:store,studentsStore:store});window.fixture.controller=controller.contentProps;return React.createElement(React.Fragment,null,React.createElement('output',{'data-schedule-state':controller.contentProps.hasLoadedRange?'ready':controller.contentProps.scheduleLoadError?'error':'loading'}),${scheduleContent === null ? "null" : `React.createElement(require(${scheduleContent}).SchedulePageContent,controller.contentProps)`});}function ScheduleMount(){const [mounted,setMounted]=React.useState(false);window.fixture.mountSchedule=()=>setMounted(true);window.fixture.unmountSchedule=()=>setMounted(false);return mounted?React.createElement(ScheduleObserver):null;}`;
  const dashboard = dashboardController ? add("@/lib/dashboard-page-controller") : null;
  const belt = beltPage ? add("@/app/(dashboard)/belt-tracker/page") : null;
  const dashboardObserver =
    dashboard === null
      ? ""
      : `function DashboardObserver(){const store=useStore();window.fixture.dashboard=require(${dashboard}).useDashboardPageController({config:store,beltStore:store,dashboardStore:store,leadStore:store,programsStore:store,scheduleStore:store,studentsStore:store,studioStore:store}).contentProps;return null;}`;
  const leadHook = leadController ? add("@/lib/leads-page-controller") : null;
  const leadModal = leadController ? add("@/components/leads/add-lead-modal") : null;
  const leadObserver =
    leadHook === null
      ? ""
      : `function LeadControllerFixture(){const store=useStore();const c=require(${leadHook}).useLeadsPageController({addLead:store.addLead,updateLead:store.updateLead,convertLeadToStudent:store.convertLeadToStudent,baseLeads:store.leads,currentRole:store.currentRole,isPreviewMode:store.isPreviewMode,programs:store.programs,today:store.businessDate,token:store.token});window.fixture.leadController=c;return React.createElement(React.Fragment,null,React.createElement('button',{onClick:c.openAddLeadModal},'New lead'),c.showAddLead?React.createElement(require(${leadModal}).AddLeadModal,{activePrograms:store.programs,activeStaff:[],programById:new Map(),selectedProgramId:c.addLeadProgramId,today:store.businessDate,addLeadError:c.addLeadError,isAddingLead:c.isAddingLead,isOutcomeUnknown:c.addLeadOutcomeUnknown,onClose:c.closeAddLeadModal,onDismissError:c.dismissAddLeadError,onProgramChange:c.setAddLeadProgramId,onSubmit:c.handleAddLead}):null);}`;
  const form = studentForm ? add("@/components/students/student-form") : null;
  const formObserver =
    form === null
      ? ""
      : `function StudentFormFixture(){const [open,setOpen]=React.useState(false);const store=useStore();return React.createElement(React.Fragment,null,React.createElement('button',{onClick:()=>setOpen(true)},'Open form'),open?React.createElement(require(${form}).StudentForm,{onClose:()=>setOpen(false),onSubmit:async(data)=>{window.fixture.submitted=data;await store.addStudent(data);}}):null);}`;
  const roster = rosterController ? add("@/lib/students-page-controller") : null;
  const rosterObserver =
    roster === null
      ? ""
      : `function RosterObserver(){const store=useStore();const result=require(${roster}).useStudentsPageController({config:store,studioStore:store,programsStore:store,studentsStore:store,scheduleStore:store});window.fixture.roster=result.contentProps;return React.createElement('div',{id:'main-content',style:{height:200,overflow:'auto'}},React.createElement('input',{'aria-label':'Search',value:result.contentProps.search,onChange:e=>result.contentProps.onSearchChange(e.target.value)}),React.createElement('button',{onClick:result.contentProps.onNextPage},'Next page'),React.createElement('div',{style:{height:800}},'Roster'),React.createElement('div',{'data-student-id':'student-1'},React.createElement('button',{'data-open-student':true,onClick:()=>result.contentProps.onOpenStudent('student-1')},'Open student')));}function RosterMount(){const [mounted,setMounted]=React.useState(false);window.fixture.mountRoster=()=>setMounted(true);window.fixture.unmountRoster=()=>setMounted(false);return mounted?React.createElement(RosterObserver):null;}`;
  const detail = detailController ? add("@/lib/student-detail-page-controller") : null;
  const detailObserver =
    detail === null
      ? ""
      : `function DetailObserver(){const store=useStore();window.fixture.detail=require(${detail}).useStudentDetailPageController({config:store,studioStore:store,beltStore:store,programsStore:store,studentsStore:store}).contentProps;return null;}function DetailMount(){const [mounted,setMounted]=React.useState(false);window.fixture.mountDetail=()=>setMounted(true);window.fixture.unmountDetail=()=>setMounted(false);return mounted?React.createElement(DetailObserver):null;}`;
  const provider =
    preview || layout ? `require(${add("@/app/(dashboard)/layout")}).default` : "StoreProvider";
  // Older lifecycle cases supply one combined bootstrap fixture. Split only
  // their external I/O fixture into workspace and feature responses. New workflow
  // cases use independent endpoints and controlled timing without this adapter.
  const legacyAdapter =
    legacyBootstrapFixture && !realApi && !preview
      ? `const originalGet=window.fixture.api.get.bind(window.fixture.api);let projected;window.fixture.api.get=async(path,...args)=>{if(path==='/dashboard/workspace'){projected=await originalGet('/dashboard/bootstrap?allow_partial=true',...args);return projected;}if(path.startsWith('/dashboard/bootstrap?'))return projected;return originalGet(path,...args);};`
      : "";
  return `(()=>{${legacyAdapter}const process={env:{NODE_ENV:${mode === "development" ? '"development"' : '"production"'},NEXT_PUBLIC_STUDENTS_PAGED_ROSTER:${pagedRoster ? '"true"' : '"false"'},NEXT_PUBLIC_PREVIEW_MODE:${preview ? '"true"' : '"false"'}}};const modules=[${modules.join(",")}],cache={};function require(id){if(cache[id])return cache[id].exports;const module=cache[id]={exports:{}};modules[id](module,module.exports,require);return module.exports;}const React=require(${react});window.fixture.beginPendingCommand=require(${pendingCommands}).beginPendingCommand;const {StoreProvider,useStore}=require(${store});${scheduleObserver}${dashboardObserver}${detailObserver}${rosterObserver}${formObserver}${leadObserver}function Observer(){const store=useStore();window.fixture.store=store;React.useEffect(()=>{window.fixture.observations.push({role:store.currentRole,ready:store.staffProfilesAvailable,user:store.currentUserId,studio:store.currentStudioId});});return React.createElement('output',null,store.staffProfilesAvailable?'ready':'pending');}window.fixture.root=require(${dom}).createRoot(document.getElementById('root'));window.fixture.root.render(React.createElement(${mode === "development" ? "React.StrictMode" : "React.Fragment"},null,React.createElement(${provider},null,React.createElement(Observer),${leads === null ? "null" : `React.createElement(require(${leads}).default)`},${programs === null ? "null" : `React.createElement(require(${programs}).ProgramsSection)`},${staff === null ? "null" : `React.createElement(require(${staff}).StaffRolesSection)`},${subscription === null ? "null" : `React.createElement(require(${subscription}).default)`},${schedule === null ? "null" : "React.createElement(ScheduleMount)"},${dashboard === null ? "null" : "React.createElement(DashboardObserver)"},${leadHook === null ? "null" : "React.createElement(LeadControllerFixture)"},${form === null ? "null" : "React.createElement(StudentFormFixture)"},${roster === null ? "null" : "React.createElement(RosterMount)"},${detail === null ? "null" : "React.createElement(DetailMount)"},${belt === null ? "null" : `React.createElement(require(${belt}).default)`})));})();`;
}
