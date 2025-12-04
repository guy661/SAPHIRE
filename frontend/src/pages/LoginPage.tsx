import { Container, Box, Typography, TextField, Button, Paper, Alert } from '@mui/material';
import { useState } from 'react';
import { useAuth } from '../context/AuthContext';

export default function LoginPage() {
  const [error, setError] = useState<string | null>(null);
  const { login } = useAuth();

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null); // Reset error on new submission
    const data = new FormData(event.currentTarget);
    const username = data.get('username') as string;
    const password = data.get('password') as string;

    if (!username || !password) {
      setError('Benutzername und Passwort sind erforderlich.');
      return;
    }

    try {
      await login(username, password);
      // On successful login, the App component will handle the redirect.
      // No need to do anything here anymore.
    } catch (err) {
      if (err instanceof Error) {
        setError(err.message);
      } else {
        setError('Ein unbekannter Fehler ist aufgetreten.');
      }
    }
  };

  return (
    <Container component="main" maxWidth="xs">
      <Paper elevation={3} sx={{ mt: 8, p: 4, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <Typography component="h1" variant="h5">
          Anmelden
        </Typography>
        <Box component="form" onSubmit={handleSubmit} noValidate sx={{ mt: 1 }}>
          {error && <Alert severity="error" sx={{ width: '100%', mb: 2 }}>{error}</Alert>}
          <TextField
            margin="normal"
            required
            fullWidth
            id="username"
            label="Benutzername"
            name="username"
            autoComplete="username"
            autoFocus
          />
          <TextField
            margin="normal"
            required
            fullWidth
            name="password"
            label="Passwort"
            type="password"
            id="password"
            autoComplete="current-password"
          />
          <Button
            type="submit"
            fullWidth
            variant="contained"
            sx={{ mt: 3, mb: 2 }}
          >
            Anmelden
          </Button>
        </Box>
      </Paper>
    </Container>
  );
}
