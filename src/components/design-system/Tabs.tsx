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
    <div className={`h-full flex flex-col ${className}`}>
      {/* Tabs - pegados al panel */}
      <div className="flex">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={`px-4 py-2 text-sm font-medium rounded-t transition-colors ${
              activeTab === tab.id
                ? 'bg-gray-800 text-white'
                : 'text-gray-400 hover:text-white hover:bg-gray-800/50'
            }`}
            onClick={() => onTabChange(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Panel principal - sin redondeado arriba */}
      <div className="flex-1 bg-gray-800 rounded-b-lg overflow-hidden">
        {/* Panel de contenido */}
        <div className="h-full overflow-y-auto">
          {tabs.find((tab) => tab.id === activeTab)?.content}
        </div>
      </div>
    </div>
  );
} 