"use client";

import { Search, X } from "lucide-react";

interface SearchBarProps {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
}

export function SearchBar({ value, onChange, placeholder = "Search projects..." }: SearchBarProps) {
    return (
        <div className="relative group max-w-md w-full">
            <div className="absolute inset-y-0 left-3 flex items-center pointer-events-none">
                <Search className="w-4 h-4 text-gray-500 group-focus-within:text-blue-400 transition-colors" />
            </div>
            <input
                type="text"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                placeholder={placeholder}
                className="w-full bg-gray-950/40 border border-gray-800 focus:border-blue-500/50 rounded-xl py-2 pl-10 pr-10 text-sm text-gray-200 placeholder:text-gray-600 focus:outline-none focus:ring-4 focus:ring-blue-500/10 backdrop-blur-md transition-all"
            />
            {value && (
                <button
                    onClick={() => onChange("")}
                    className="absolute inset-y-0 right-3 flex items-center text-gray-500 hover:text-gray-300 transition-colors"
                >
                    <X className="w-4 h-4" />
                </button>
            )}
        </div>
    );
}
