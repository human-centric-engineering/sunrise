# Mobile App Integration Guide

**Version**: 1.0.0
**Last Updated**: 2026-01-07
**Status**: Production-ready

## Overview

This guide covers how mobile applications (React Native, Flutter, iOS, Android) should integrate with Sunrise's authentication and API systems.

**Key Principle**: Mobile apps should use better-auth endpoints directly for authentication, not custom endpoints. This ensures consistent behavior, security, and compatibility.

## Authentication

### Self-Signup (User Registration)

**Endpoint**: `POST /api/auth/sign-up/email`

**Implementation** (React Native example):

```typescript
// services/auth.ts
const API_URL = 'https://your-app.com';

interface SignUpData {
  name: string;
  email: string;
  password: string;
}

interface SignUpResponse {
  user: {
    id: string;
    name: string;
    email: string;
    role: string;
  };
  session: {
    token: string;
    expiresAt: string;
  };
}

async function signUp(data: SignUpData): Promise<SignUpResponse> {
  const response = await fetch(`${API_URL}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Signup failed');
  }

  return response.json();
}

// Usage
try {
  const result = await signUp({
    name: 'John Doe',
    email: 'john@example.com',
    password: 'SecurePassword123!',
  });

  // Store session token securely
  await SecureStore.setItemAsync('session_token', result.session.token);
  await SecureStore.setItemAsync('user_id', result.user.id);

  // Navigate to app
  navigation.navigate('Home');
} catch (error) {
  console.error('Signup error:', error);
  // Show error to user
}
```

**Email Verification**:

- **Development**: Disabled by default (user can login immediately)
- **Production**: Enabled by default (user must verify email before login)
- **Handling**: Check for verification error on login, prompt user to check email

### Sign In (Email & Password)

**Endpoint**: `POST /api/auth/sign-in/email`

**Implementation**:

```typescript
interface SignInData {
  email: string;
  password: string;
}

interface SignInResponse {
  user: {
    id: string;
    name: string;
    email: string;
    role: string;
  };
  session: {
    token: string;
    expiresAt: string;
  };
}

async function signIn(data: SignInData): Promise<SignInResponse> {
  const response = await fetch(`${API_URL}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Login failed');
  }

  return response.json();
}

// Usage
try {
  const result = await signIn({
    email: 'john@example.com',
    password: 'SecurePassword123!',
  });

  // Store session token securely
  await SecureStore.setItemAsync('session_token', result.session.token);
  await SecureStore.setItemAsync('user_id', result.user.id);

  navigation.navigate('Home');
} catch (error) {
  console.error('Login error:', error);
  // Show error to user
}
```

### Sign Out

**Endpoint**: `POST /api/auth/sign-out`

**Implementation**:

```typescript
async function signOut(): Promise<void> {
  const token = await SecureStore.getItemAsync('session_token');

  const response = await fetch(`${API_URL}/api/auth/sign-out`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `better-auth.session_token=${token}`,
    },
  });

  // Clear local storage regardless of response
  await SecureStore.deleteItemAsync('session_token');
  await SecureStore.deleteItemAsync('user_id');

  navigation.navigate('Login');
}
```

### Get Session

**Endpoint**: `GET /api/auth/session`

**Implementation**:

```typescript
interface SessionResponse {
  user: {
    id: string;
    name: string;
    email: string;
    role: string;
  };
  session: {
    token: string;
    expiresAt: string;
  };
}

async function getSession(): Promise<SessionResponse | null> {
  const token = await SecureStore.getItemAsync('session_token');

  if (!token) {
    return null;
  }

  const response = await fetch(`${API_URL}/api/auth/session`, {
    method: 'GET',
    headers: {
      Cookie: `better-auth.session_token=${token}`,
    },
  });

  if (!response.ok) {
    // Session invalid, clear local storage
    await SecureStore.deleteItemAsync('session_token');
    await SecureStore.deleteItemAsync('user_id');
    return null;
  }

  return response.json();
}

// Usage: Check session on app start
useEffect(() => {
  async function checkSession() {
    const session = await getSession();
    if (session) {
      setUser(session.user);
      navigation.navigate('Home');
    } else {
      navigation.navigate('Login');
    }
  }
  checkSession();
}, []);
```

## Session Management

### Secure Storage

**Best Practices**:

- **React Native**: Use `expo-secure-store` or `react-native-keychain`
- **iOS**: Use Keychain Services
- **Android**: Use EncryptedSharedPreferences or Keystore
- **Never**: Use AsyncStorage for tokens (not secure)

**Implementation** (React Native with Expo):

```typescript
import * as SecureStore from 'expo-secure-store';

export const SessionStorage = {
  async setToken(token: string): Promise<void> {
    await SecureStore.setItemAsync('session_token', token);
  },

  async getToken(): Promise<string | null> {
    return await SecureStore.getItemAsync('session_token');
  },

  async clearToken(): Promise<void> {
    await SecureStore.deleteItemAsync('session_token');
  },
};
```

### Session Expiration

**Default Expiration**: 30 days

**Handling**:

```typescript
async function makeAuthenticatedRequest(url: string, options: RequestInit = {}) {
  const token = await SessionStorage.getToken();

  if (!token) {
    navigation.navigate('Login');
    throw new Error('No session token');
  }

  const response = await fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      Cookie: `better-auth.session_token=${token}`,
    },
  });

  if (response.status === 401) {
    // Session expired, clear storage and redirect to login
    await SessionStorage.clearToken();
    navigation.navigate('Login');
    throw new Error('Session expired');
  }

  return response;
}
```

### Refresh Pattern

**Strategy**: Automatic refresh on API calls

```typescript
async function makeAuthenticatedRequest(url: string, options: RequestInit = {}) {
  const token = await SessionStorage.getToken();

  const response = await fetch(url, {
    ...options,
    headers: {
      ...options.headers,
      Cookie: `better-auth.session_token=${token}`,
    },
  });

  // Check for new session token in response
  const setCookie = response.headers.get('set-cookie');
  if (setCookie && setCookie.includes('better-auth.session_token')) {
    // Extract and store new token
    const match = setCookie.match(/better-auth\.session_token=([^;]+)/);
    if (match) {
      await SessionStorage.setToken(match[1]);
    }
  }

  return response;
}
```

## API Integration

### Type-Safe API Client

**Implementation**:

```typescript
// api/client.ts
const API_URL = 'https://your-app.com';

interface APIResponse<T> {
  success: true;
  data: T;
  meta?: Record<string, unknown>;
}

interface APIError {
  success: false;
  error: {
    message: string;
    code: string;
    details?: Record<string, unknown>;
  };
}

class APIClient {
  private async getToken(): Promise<string | null> {
    return await SessionStorage.getToken();
  }

  async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const token = await this.getToken();
    const url = `${API_URL}${endpoint}`;

    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(token && { Cookie: `better-auth.session_token=${token}` }),
        ...options.headers,
      },
    });

    const data: APIResponse<T> | APIError = await response.json();

    if (!data.success) {
      throw new Error(data.error.message);
    }

    return data.data;
  }

  async get<T>(endpoint: string): Promise<T> {
    return this.request<T>(endpoint, { method: 'GET' });
  }

  async post<T>(endpoint: string, body: unknown): Promise<T> {
    return this.request<T>(endpoint, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async patch<T>(endpoint: string, body: unknown): Promise<T> {
    return this.request<T>(endpoint, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
  }

  async delete<T>(endpoint: string): Promise<T> {
    return this.request<T>(endpoint, { method: 'DELETE' });
  }
}

export const apiClient = new APIClient();
```

### Usage Example

```typescript
// hooks/useUser.ts
import { useEffect, useState } from 'react';
import { apiClient } from '@/api/client';

interface User {
  id: string;
  name: string;
  email: string;
  role: string;
}

export function useUser() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchUser() {
      try {
        const data = await apiClient.get<User>('/api/v1/users/me');
        setUser(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to fetch user');
      } finally {
        setLoading(false);
      }
    }

    fetchUser();
  }, []);

  return { user, loading, error };
}

// Component usage
function ProfileScreen() {
  const { user, loading, error } = useUser();

  if (loading) return <Loading />;
  if (error) return <Error message={error} />;
  if (!user) return <NotFound />;

  return <Profile user={user} />;
}
```

## Error Handling

### Standard Error Codes

```typescript
enum ErrorCode {
  UNAUTHORIZED = 'UNAUTHORIZED',
  FORBIDDEN = 'FORBIDDEN',
  NOT_FOUND = 'NOT_FOUND',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  EMAIL_TAKEN = 'EMAIL_TAKEN',
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
}

function handleAPIError(error: { code: string; message: string; details?: unknown }) {
  switch (error.code) {
    case ErrorCode.UNAUTHORIZED:
      // Redirect to login
      navigation.navigate('Login');
      break;

    case ErrorCode.FORBIDDEN:
      // Show permission error
      Alert.alert('Permission Denied', error.message);
      break;

    case ErrorCode.VALIDATION_ERROR:
      // Show validation errors
      if (error.details && typeof error.details === 'object') {
        showValidationErrors(error.details);
      }
      break;

    case ErrorCode.EMAIL_TAKEN:
      // Show email already registered error
      Alert.alert('Email Already Registered', error.message);
      break;

    default:
      // Show generic error
      Alert.alert('Error', error.message);
  }
}
```

## Platform-Specific Considerations

### React Native

**Dependencies**:

```json
{
  "expo-secure-store": "^13.0.1",
  "@react-native-async-storage/async-storage": "^1.21.0"
}
```

**Network Security** (Android):

Add to `android/app/src/main/AndroidManifest.xml`:

```xml
<application
  android:usesCleartextTraffic="true"  <!-- Only for development -->
  android:networkSecurityConfig="@xml/network_security_config">
```

### Flutter

**Dependencies**:

```yaml
dependencies:
  flutter_secure_storage: ^9.0.0
  http: ^1.1.0
```

**Implementation**:

```dart
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

class AuthService {
  final storage = FlutterSecureStorage();
  final apiUrl = 'https://your-app.com';

  Future<void> signIn(String email, String password) async {
    final response = await http.post(
      Uri.parse('$apiUrl/api/auth/sign-in/email'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode({'email': email, 'password': password}),
    );

    if (response.statusCode == 200) {
      final data = jsonDecode(response.body);
      await storage.write(key: 'session_token', value: data['session']['token']);
    }
  }
}
```

### iOS Native

**Keychain Storage**:

```swift
import Security

class AuthService {
    func saveToken(_ token: String) {
        let data = token.data(using: .utf8)!
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: "session_token",
            kSecValueData as String: data
        ]
        SecItemAdd(query as CFDictionary, nil)
    }

    func getToken() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: "session_token",
            kSecReturnData as String: true
        ]
        var result: AnyObject?
        SecItemCopyMatching(query as CFDictionary, &result)
        if let data = result as? Data {
            return String(data: data, encoding: .utf8)
        }
        return nil
    }
}
```

### Android Native

**EncryptedSharedPreferences**:

```kotlin
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

class AuthService(context: Context) {
    private val masterKey = MasterKey.Builder(context)
        .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
        .build()

    private val sharedPreferences = EncryptedSharedPreferences.create(
        context,
        "secure_prefs",
        masterKey,
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
    )

    fun saveToken(token: String) {
        sharedPreferences.edit().putString("session_token", token).apply()
    }

    fun getToken(): String? {
        return sharedPreferences.getString("session_token", null)
    }
}
```

## Testing

### Mock API for Development

```typescript
// mock/api.ts
const MOCK_ENABLED = __DEV__ && process.env.MOCK_API === 'true';

export const apiClient = MOCK_ENABLED ? mockAPIClient : realAPIClient;

// mock/mockAPIClient.ts
export const mockAPIClient = {
  async signIn(email: string, password: string) {
    await delay(500); // Simulate network
    return {
      user: { id: '1', name: 'Test User', email, role: 'USER' },
      session: { token: 'mock-token', expiresAt: '2026-12-31' },
    };
  },
};
```

### Integration Testing

```typescript
// tests/auth.test.ts
import { signIn } from '@/services/auth';

describe('Authentication', () => {
  it('should sign in successfully', async () => {
    const result = await signIn({
      email: 'test@example.com',
      password: 'password123',
    });

    expect(result.user).toBeDefined();
    expect(result.session.token).toBeDefined();
  });

  it('should handle invalid credentials', async () => {
    await expect(signIn({ email: 'test@example.com', password: 'wrong' })).rejects.toThrow(
      'Login failed'
    );
  });
});
```

## Related Documentation

- [Authentication Overview](../auth/overview.md) - Complete authentication system
- [User Creation Patterns](../auth/user-creation.md) - Self-signup and invitation flows
- [API Endpoints](./endpoints.md) - Complete API reference
- [API Examples](./examples.md) - Web client examples
