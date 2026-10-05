/**
 * The /try page: a working miniature of Koaryu set up for one evening class.
 * Every person here is sample data; nothing is fetched or saved.
 */
import { formatPublicPlatformPrice } from "../../../lib/constants.ts";

export type BeltRank = "white" | "yellow" | "orange" | "green";

/** A student in the hands-on class demo. Counts are before tonight's class. */
export interface DemoStudent {
  id: string;
  name: string;
  belt: BeltRank;
  nextBelt: BeltRank;
  /** Classes attended toward the next rank before this class. */
  attended: number;
  required: number;
  daysAtRank: number;
  daysRequired: number;
  /** Whether the next rank also needs an instructor's sign-off once the counts are met. */
  needsApproval: boolean;
  guardian: string;
  /** The last few classes, oldest first. */
  history: readonly ("present" | "late" | "absent")[];
}

export type DemoLeadStage =
  "inquiry" | "trial_scheduled" | "trial_completed" | "offer_sent" | "enrolled";

export type DemoLeadSource = "walk_in" | "referral" | "social" | "search" | "website" | "other";

/** A lead in the demo's follow-up queue. `dueIn` is days from today; negative is overdue. */
export interface DemoLead {
  id: string;
  name: string;
  stage: DemoLeadStage;
  program: string;
  source: DemoLeadSource;
  dueIn: number;
  owner: string | null;
  minor: boolean;
}

export interface DemoTask {
  id: "mark" | "ready" | "lead";
  label: string;
  detail: string;
}

export interface TryLink {
  label: string;
  href: string;
}

export const tryPageContent = {
  meta: {
    title: "Try Koaryu on tonight's class | Koaryu",
    description:
      "Take attendance, watch a student become ready for her next belt and add a trial lead in a working miniature of Koaryu, studio software for independent martial arts schools. Sample data, nothing saved.",
    path: "/try",
  },
  hero: {
    headline: ["Try Koaryu on", "tonight's class."],
    lede: "Kids Karate starts at six. This is a working miniature of Koaryu with six sample students and a few trial families. Tap anything; nothing you change is saved.",
  },
  guide: {
    title: "Three things to try",
    allDone: "That's a class night in Koaryu.",
    allDoneDetail: "Your own roster, ranks and leads are a few minutes away.",
    action: { label: "Create an account", href: "/signup" },
  },
  studio: {
    tasks: [
      {
        id: "mark",
        label: "Take attendance",
        detail: "Tap a student to cycle Present, Late and Absent.",
      },
      {
        id: "ready",
        label: "Finish Maya's requirement",
        detail: "She is one class short of Yellow Belt.",
      },
      {
        id: "lead",
        label: "Add a trial lead",
        detail: "Then move it along the follow-up queue.",
      },
    ],
    studioName: "Riverside Karate",
    session: {
      name: "Kids Karate",
      day: "Tuesday",
      time: "6:00 – 6:45 PM",
    },
    programs: ["Kids Karate", "Teen & Adult Karate"],
    students: [
      {
        id: "zara",
        name: "Zara Ali",
        belt: "white",
        nextBelt: "yellow",
        attended: 3,
        required: 8,
        daysAtRank: 41,
        daysRequired: 60,
        needsApproval: false,
        guardian: "Samira Ali",
        history: ["present", "absent", "present", "late", "present"],
      },
      {
        id: "noah",
        name: "Noah Bennett",
        belt: "yellow",
        nextBelt: "orange",
        attended: 5,
        required: 10,
        daysAtRank: 72,
        daysRequired: 60,
        needsApproval: false,
        guardian: "Claire Bennett",
        history: ["present", "present", "absent", "present", "present"],
      },
      {
        id: "hana",
        name: "Hana Mori",
        belt: "orange",
        nextBelt: "green",
        attended: 9,
        required: 12,
        daysAtRank: 88,
        daysRequired: 90,
        needsApproval: true,
        guardian: "Kenji Mori",
        history: ["present", "present", "present", "late", "present"],
      },
      {
        id: "liam",
        name: "Liam Johnson",
        belt: "white",
        nextBelt: "yellow",
        attended: 6,
        required: 8,
        daysAtRank: 55,
        daysRequired: 60,
        needsApproval: false,
        guardian: "Dana Johnson",
        history: ["absent", "present", "present", "present", "absent"],
      },
      {
        id: "maya",
        name: "Maya Chen",
        belt: "white",
        nextBelt: "yellow",
        attended: 7,
        required: 8,
        daysAtRank: 64,
        daysRequired: 60,
        needsApproval: false,
        guardian: "Wei Chen",
        history: ["present", "present", "late", "present", "present"],
      },
      {
        id: "omar",
        name: "Omar Haddad",
        belt: "yellow",
        nextBelt: "orange",
        attended: 8,
        required: 10,
        daysAtRank: 96,
        daysRequired: 60,
        needsApproval: false,
        guardian: "Lina Haddad",
        history: ["present", "late", "present", "present", "present"],
      },
    ],
    ready: {
      student: "maya",
      decision: "Requirements met. Whether she tests is the instructor's call.",
    },
    leads: [
      {
        id: "sarah",
        name: "Sarah Kim",
        stage: "offer_sent",
        program: "Kids Karate",
        source: "walk_in",
        dueIn: -2,
        owner: null,
        minor: true,
      },
      {
        id: "david",
        name: "David Chen",
        stage: "inquiry",
        program: "Teen & Adult Karate",
        source: "website",
        dueIn: -1,
        owner: "Ana Reyes",
        minor: false,
      },
      {
        id: "maria",
        name: "Maria Gonzalez",
        stage: "trial_scheduled",
        program: "Kids Karate",
        source: "referral",
        dueIn: 0,
        owner: null,
        minor: true,
      },
      {
        id: "tyler",
        name: "Tyler Brooks",
        stage: "trial_completed",
        program: "Teen & Adult Karate",
        source: "social",
        dueIn: 2,
        owner: "Ana Reyes",
        minor: false,
      },
    ],
    newLead: { name: "Jordan Rivera", program: "Kids Karate", source: "walk_in", dueIn: 1 },
    caption: "Interactive demo with sample students and leads. Nothing is saved.",
  },
  real: {
    title: "Now, the real thing.",
    lede: "That was a miniature. This is Koaryu's belt tracker at full size: requirements you define for each program, and who meets every one, rank by rank. It runs in the browser, so the same screen fits a phone.",
    price: `${formatPublicPlatformPrice()} per studio, per month. Every student, no tiers.`,
    image: {
      src: "/marketing/product/belt-tracker.webp",
      width: 2400,
      height: 1500,
      alt: "Koaryu belt tracker listing students by current rank, with classes attended and time at rank toward the next belt.",
      mobile: {
        src: "/marketing/product/belt-tracker-mobile.webp",
        width: 780,
        height: 1520,
        alt: "The same belt tracker in Koaryu's phone layout.",
      },
    },
    caption: "Belt tracker, shown with sample studio data.",
    actions: [
      { label: "Create an account", href: "/signup" },
      { label: "Back to the home page", href: "/" },
    ],
  },
} as const satisfies {
  meta: { title: string; description: string; path: string };
  hero: { headline: readonly [string, string]; lede: string };
  guide: { title: string; allDone: string; allDoneDetail: string; action: TryLink };
  studio: {
    tasks: readonly DemoTask[];
    studioName: string;
    session: { name: string; day: string; time: string };
    programs: readonly string[];
    students: readonly DemoStudent[];
    ready: { student: string; decision: string };
    leads: readonly DemoLead[];
    newLead: { name: string; program: string; source: DemoLeadSource; dueIn: number };
    caption: string;
  };
  real: {
    title: string;
    lede: string;
    price: string;
    image: {
      src: string;
      width: number;
      height: number;
      alt: string;
      mobile: { src: string; width: number; height: number; alt: string };
    };
    caption: string;
    actions: readonly [TryLink, TryLink];
  };
};

export type TryPageContent = typeof tryPageContent;
