import { createContext, useContext, ReactNode, useState, useEffect, useCallback } from 'react';
import { jwtVerify, importSPKI, JWTPayload } from 'jose';
import apiService from '@/lib/api';
import { getBrowserInfo } from '@/lib/utils';
import {
  BYPASS_AUTH,
  AUTH_TOKEN,
  BYPASS_AUTH_MOBILE,
  BYPASS_AUTH_NAME,
  BYPASS_AUTH_ROLE,
  BYPASS_AUTH_METADATA,
} from '@/config/env';

// Constants
const JWT_STORAGE_KEY = 'auth_jwt';
const JWT_EXPIRY_MINUTES = 20; // 20 minutes expiration

// User interface that contains the essential user information
export interface User {
  authenticated: boolean;
  username: string;
  email: string;
  isGuest: boolean; // Flag to identify guest users
}

// Auth context interface
interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  login: (username: string, password: string) => Promise<boolean>;
  logout: () => void;
  setAuthToken: (token: string) => Promise<boolean>;
}

// Create the context with a default value
const AuthContext = createContext<AuthContextType>({
  user: null,
  isLoading: true,
  login: async () => false,
  logout: () => {},
  setAuthToken: async () => false,
});

// Props for the AuthProvider component
interface AuthProviderProps {
  children: ReactNode;
}

// AuthProvider component that will wrap the application
export function AuthProvider({ children }: AuthProviderProps) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [publicKey, setPublicKey] = useState<CryptoKey | null>(null);

  // JWT validation public key
  const publicKeyPEM = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAoiAT5pkWCk7KgBXDFO6C
FHo1fmVMUHOCDXJ1EcAb11REiSHgxlP9TPLCs8qPSe5eeJAHGn9sqB0p0jC8cWzh
RvnrCqRhNXhmOyqrCTudBT8ePnMYU7H/dpoqF1zpYctDVkaYOf0l/H+uWk55f+Zy
zZVcpQAi2lTwNQP2teIHqt4YNsOKmX9J2BvczRj4wdCpp84+UkFJ+lVftHbEoxYM
OnCObibmuJDPvwrkHtACJZFy1Dc371evaaTN3dGE/P7MLXRA+XtInY5lYfsB23/Q
a37S+srKe59wFypSMOU+ZMvgFA2oK0zA1WEC93000n5HEQMJU8r7pCgKhq7oD8QJ
hwIDAQAB
-----END PUBLIC KEY-----`;

  // Store JWT in localStorage with expiration
  const storeJWT = (token: string) => {
    try {
      const now = new Date();
      const expiryDate = new Date(now);
      expiryDate.setMinutes(now.getMinutes() + JWT_EXPIRY_MINUTES);
      
      const tokenData = {
        token,
        expiry: expiryDate.getTime()
      };
      
      localStorage.setItem(JWT_STORAGE_KEY, JSON.stringify(tokenData));
      return true;
    } catch (error) {
      console.error("Error storing JWT:", error);
      return false;
    }
  };

  // Fetch new JWT token from /chat/auth and store it
  const fetchAndStoreNewToken = useCallback(async (importedPublicKey: CryptoKey | null) => {
    try {
      // Get browser info to send as meta parameter
      const browserInfo = getBrowserInfo();
      
      // Call /chat/auth to get JWT token
      const newToken = await apiService.fetchAuthToken(browserInfo);
      
      // Validate and store the new token
      if (importedPublicKey) {
        const result = await validateJWT(newToken, importedPublicKey);
        if (result.isValid) {
          storeJWT(newToken);
          createUserFromPayload(result.payload);
        } else {
          console.error('Received invalid token from /chat/auth');
        }
      } else {
        // If public key is not available, store token anyway
        storeJWT(newToken);
        // Create a basic authenticated user
        setUser({
          username: 'user',
          email: 'user@example.com',
          authenticated: true,
          isGuest: false,
        });
      }
    } catch (error) {
      console.error('Failed to fetch auth token from /chat/auth:', error);
    }
  }, []);

  // Initialize auth state on component mount
  useEffect(() => {
    const initAuth = async () => {
      try {
        setIsLoading(true);

        // --- Bypass Auth Mode ---
        // When VITE_BYPASS_AUTH=true, skip JWT validation entirely.
        // Optionally use VITE_AUTH_TOKEN as the static bearer token for API calls.
        if (BYPASS_AUTH) {
          console.warn('[Auth] Bypass auth enabled — fetching token from /api/token');
          try {
            // Dynamically fetch a real access token using env-configured credentials
            const { token: bypassToken, expires_in } = await apiService.fetchBypassToken({
              mobile: BYPASS_AUTH_MOBILE,
              name: BYPASS_AUTH_NAME,
              role: BYPASS_AUTH_ROLE,
              metadata: BYPASS_AUTH_METADATA,
            });

            // Store the fetched token with the server-provided expiry
            const tokenData = {
              token: bypassToken,
              expiry: Date.now() + expires_in * 1000, // expires_in is in seconds
            };
            localStorage.setItem(JWT_STORAGE_KEY, JSON.stringify(tokenData));

            // Update the ApiService auth header immediately
            apiService.updateAuthToken();

            console.info('[Auth] Bypass token acquired successfully');
          } catch (err) {
            console.error('[Auth] Failed to fetch bypass token:', err);
            // Fallback: if a static AUTH_TOKEN is provided in env, use it
            if (AUTH_TOKEN) {
              const tokenData = {
                token: AUTH_TOKEN,
                expiry: new Date().getTime() + 24 * 60 * 60 * 1000,
              };
              localStorage.setItem(JWT_STORAGE_KEY, JSON.stringify(tokenData));
              apiService.updateAuthToken();
              console.warn('[Auth] Fell back to static VITE_AUTH_TOKEN');
            }
          }
          setUser({
            authenticated: true,
            username: BYPASS_AUTH_NAME || 'Dev User',
            email: 'dev@localhost',
            isGuest: false,
          });
          setIsLoading(false);
          return;
        }

        // --- Normal Auth Flow ---
        // Import the public key
        const importedPublicKey = await importSPKI(publicKeyPEM, 'RS256');
        setPublicKey(importedPublicKey);

        // Check URL params first for new JWT (backward compatibility)
        const urlParams = new URLSearchParams(window.location.search);
        const tokenFromUrl = urlParams.get('token');

        // If JWT exists in URL, validate and store it (backward compatibility)
        if (tokenFromUrl) {
          if (importedPublicKey) {
            const result = await validateJWT(tokenFromUrl, importedPublicKey);
            if (result.isValid) {
              storeJWT(tokenFromUrl);
              createUserFromPayload(result.payload);
              // Clean up URL by removing the JWT parameter
              const newUrl = window.location.pathname + window.location.hash;
              window.history.replaceState({}, document.title, newUrl);
            } else {
              // Invalid token from URL, try to get new token
              await fetchAndStoreNewToken(importedPublicKey);
            }
          } else {
               console.error('Public key not loaded.');
               await fetchAndStoreNewToken(importedPublicKey);
          }
        }
        // Otherwise, check for JWT in localStorage
        else {
          const storedToken = getStoredJWT();
          if (storedToken) {
             if (importedPublicKey) {
              const result = await validateJWT(storedToken, importedPublicKey);
              if (result.isValid) {
                createUserFromPayload(result.payload);
              } else {
                // Token is invalid or expired, fetch new token from /chat/auth
                localStorage.removeItem(JWT_STORAGE_KEY);
                await fetchAndStoreNewToken(importedPublicKey);
              }
             } else {
               console.error('Public key not loaded.');
               await fetchAndStoreNewToken(importedPublicKey);
             }
          } else {
            // No token found, fetch new token from /chat/auth
            await fetchAndStoreNewToken(importedPublicKey);
          }
        }
      } catch (error) {
        console.error("Auth initialization error:", error);
      } finally {
        setIsLoading(false);
      }
    };

    initAuth();
  }, [publicKeyPEM, fetchAndStoreNewToken]);

  // Create a user object from JWT payload
  const createUserFromPayload = (payload: JWTPayload | null) => {
    if (!payload) {
      setUser(null);
      return;
    }
    
    // Extract name from payload, use fallbacks
    const name = payload.name as string || 'Anonymous User';
    
    // For email, try to get from payload or use fallback
    // let email = 'user@example.com';
    let email = '';
    if (payload.email) {
      email = payload.email as string;
    } else if (payload.sub) {
      email = `${payload.sub}@example.com`;
    }
    
    setUser({
      authenticated: true,
      username: name,
      email: email,
      isGuest: false
    });
  };

  // Retrieve JWT from localStorage
  const getStoredJWT = (): string | null => {
    try {
      const tokenData = localStorage.getItem(JWT_STORAGE_KEY);
      if (!tokenData) return null;
      
      const parsedData = JSON.parse(tokenData);
      const now = new Date().getTime();
      
      // Check if token is expired
      if (now > parsedData.expiry) {
        localStorage.removeItem(JWT_STORAGE_KEY);
        return null;
      }
      
      return parsedData.token;
    } catch (error) {
      console.error("Error retrieving JWT:", error);
      return null;
    }
  };

  // Function to validate JWT and extract payload
  async function validateJWT(token: string, key: CryptoKey): Promise<{ isValid: boolean; payload: JWTPayload | null }> {
    try {
      const { payload } = await jwtVerify(token, key);
      return { isValid: true, payload };
    } catch (e) {
      console.error('JWT verification failed:', e);
      return { isValid: false, payload: null };
    }
  }

  // Public method to set auth token
  const setAuthToken = async (token: string): Promise<boolean> => {
    try {
      if (publicKey) {
        const result = await validateJWT(token, publicKey);
        if (result.isValid) {
          storeJWT(token);
          createUserFromPayload(result.payload);
          return true;
        }
      }
      return false;
    } catch (error) {
      console.error("Error setting auth token:", error);
      return false;
    }
  };

  // Login function - to be implemented with actual API call
  const login = async (username: string, password: string): Promise<boolean> => {
    // This should be implemented with actual API call
    setIsLoading(true);
    try {
      // In a real implementation, this would call your authentication API
      // and get back a real JWT token
      console.log('Login called with:', username, password);
      return false; // Return false since we're not implementing real login yet
    } catch (error) {
      console.error('Login failed:', error);
      return false;
    } finally {
      setIsLoading(false);
    }
  };

  // Logout function
  const logout = () => {
    // Clear user data and token
    setUser(null);
    localStorage.removeItem(JWT_STORAGE_KEY);
  };

  return (
    <AuthContext.Provider value={{ user, isLoading, login, logout, setAuthToken }}>
      {children}
    </AuthContext.Provider>
  );
}

// Custom hook to use the auth context
export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
} 