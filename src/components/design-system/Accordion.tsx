import { ReactNode } from 'react';
import { ChevronDownIcon } from '../icons/ChevronDownIcon';

interface AccordionItemProps {
  title: string;
  children: ReactNode;
  isExpanded: boolean;
  onToggle: () => void;
}

interface AccordionProps {
  sections: {
    id: string;
    title: string;
    content: ReactNode;
  }[];
  expandedSection?: string | null;
  onSectionChange: (sectionId: string | null) => void;
  className?: string;
}

function AccordionItem({ 
  title, 
  children, 
  isExpanded, 
  onToggle 
}: AccordionItemProps) {
  return (
    <div>
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between text-sm font-medium 
          text-white hover:text-gray-300 transition-colors p-4"
      >
        <span>{title}</span>
        <ChevronDownIcon 
          className={`w-5 h-5 transition-transform duration-300 ${
            !isExpanded ? '-rotate-90' : ''
          }`}
        />
      </button>
      <div 
        className={`grid transition-[grid-template-rows] duration-300 ease-out
          ${isExpanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}
      >
        <div className="overflow-hidden">
          <div className="flex flex-col gap-6 px-4 pb-4">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

export function Accordion({
  sections,
  expandedSection,
  onSectionChange,
  className = ''
}: AccordionProps) {
  return (
    <div className={`flex flex-col divide-y divide-gray-700 ${className}`}>
      {sections.map(section => (
        <AccordionItem
          key={section.id}
          title={section.title}
          isExpanded={expandedSection === section.id}
          onToggle={() => onSectionChange(expandedSection === section.id ? null : section.id)}
        >
          {section.content}
        </AccordionItem>
      ))}
    </div>
  );
} 