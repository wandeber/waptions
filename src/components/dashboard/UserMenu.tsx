"use client";

import { useState, useRef, useEffect } from "react";
import { useSession, signOut } from "next-auth/react";
import { LogOut, User as UserIcon, ChevronDown } from "lucide-react";
import Image from "next/image";

export function UserMenu() {
    const { data: session } = useSession();
    const [isOpen, setIsOpen] = useState(false);
    const menuRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (session?.user?.image) {
            console.log("Profile Image URL:", session.user.image);
        }
    }, [session]);

    useEffect(() => {
        function handleClickOutside(event: MouseEvent) {
            if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        }
        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, []);

    if (!session?.user) return null;

    return (
        <div className="relative" ref={menuRef}>
            <button
                onClick={() => setIsOpen(!isOpen)}
                className="flex items-center gap-2 p-1 rounded-lg hover:bg-gray-800 transition-colors border border-transparent hover:border-gray-700"
            >
                <div className="relative w-8 h-8 rounded-full overflow-hidden border border-gray-700">
                    {session.user.image ? (
                        <Image
                            src={session.user.image}
                            alt={session.user.name || "User"}
                            fill
                            unoptimized
                            className="object-cover"
                        />
                    ) : (
                        <div className="w-full h-full bg-gray-700 flex items-center justify-center">
                            <UserIcon className="w-4 h-4 text-gray-400" />
                        </div>
                    )}
                </div>
                <ChevronDown className={`w-4 h-4 text-gray-400 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
            </button>

            {isOpen && (
                <div className="absolute right-0 mt-2 w-64 bg-gray-900 border border-gray-800 rounded-xl shadow-2xl py-2 z-50 animate-in fade-in zoom-in duration-200">
                    <div className="px-4 py-3 border-b border-gray-800">
                        <p className="text-sm font-bold text-white truncate">
                            {session.user.name}
                        </p>
                        <p className="text-xs text-gray-400 truncate">
                            {session.user.email}
                        </p>
                    </div>

                    <div className="mt-1">
                        <button
                            onClick={() => signOut({ callbackUrl: "/login" })}
                            className="w-full flex items-center gap-2 px-4 py-2 text-sm text-red-400 hover:bg-red-400/10 transition-colors"
                        >
                            <LogOut className="w-4 h-4" />
                            <span>Sign out</span>
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
