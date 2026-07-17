import { ReactNode } from 'react';

interface Tab {
  id: string;
  label: string;
  content: ReactNode;
}

interface TabsProps {
  tabs: Tab[];
  activeTab: string;
  onTabChange: (tabId: string) => void;
  className?: string;
}

export function Tabs({ tabs, activeTab, onTabChange, className = '' }: TabsProps) {
  return (
    <div className={`flex h-full flex-col ${className}`}>
      <div className="flex flex-none border-b border-slate-700 bg-slate-900 px-2">
        {tabs.map((tab) => (
          <button
            type="button"
            key={tab.id}
            className={`relative h-9 px-3 text-xs font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-sky-400 ${
              activeTab === tab.id
                ? 'text-white after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:bg-sky-400'
                : 'text-slate-400 hover:bg-slate-800/70 hover:text-white'
            }`}
            onClick={() => onTabChange(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-hidden bg-slate-900">
        <div className="h-full overflow-y-auto">
          {tabs.find((tab) => tab.id === activeTab)?.content}
        </div>
      </div>
    </div>
  );
}
