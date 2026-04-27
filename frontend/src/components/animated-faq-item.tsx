"use client";

import { useId, useState } from "react";
import { Plus } from "lucide-react";

interface AnimatedFaqItemProps {
  question: string;
  answer: string;
}

export function AnimatedFaqItem({ question, answer }: AnimatedFaqItemProps) {
  const [isOpen, setIsOpen] = useState(false);
  const panelId = useId();

  return (
    <div className="faq-item" data-state={isOpen ? "open" : "closed"}>
      <button
        type="button"
        aria-expanded={isOpen}
        aria-controls={panelId}
        className="flex w-full cursor-pointer items-start justify-between gap-6 py-5 text-left text-sm font-medium text-text-primary"
        onClick={() => setIsOpen((current) => !current)}
      >
        <span>{question}</span>
        <Plus className="faq-icon mt-0.5 h-4 w-4 shrink-0 text-accent" />
      </button>
      <div id={panelId} className="faq-body" aria-hidden={!isOpen}>
        <div>
          <p className="pb-5 pr-10 text-sm leading-6 text-text-secondary">
            {answer}
          </p>
        </div>
      </div>
    </div>
  );
}
