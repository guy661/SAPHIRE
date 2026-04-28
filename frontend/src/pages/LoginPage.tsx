import { Container, Box, Typography, TextField, Button, Paper, Alert, MenuItem } from '@mui/material';
import { useState } from 'react';
import { useAuth } from '../context/AuthContext';

export default function LoginPage() {
  const [isRegister, setIsRegister] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { login, register } = useAuth();

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    const data = new FormData(event.currentTarget);
    const username = data.get('username') as string;
    const password = data.get('password') as string;
    const language = data.get('language') as string || 'de';

    if (!username || !password) {
      setError('Benutzername und Passwort sind erforderlich.');
      return;
    }

    try {
      if (isRegister) {
        await register(username, password, language);
      } else {
        await login(username, password);
      }
    } catch (err) {
      if (err instanceof Error) {
        setError(err.message);
      } else {
        setError('Ein unbekannter Fehler ist aufgetreten.');
      }
    }
  };

  const toggleMode = () => {
    setIsRegister(!isRegister);
    setError(null);
  };

  return (
    <Container component="main" maxWidth="xs">
      <Paper elevation={3} sx={{ mt: 8, p: 4, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <Typography component="h1" variant="h5">
          {isRegister ? 'Registrieren' : 'Anmelden'}
        </Typography>
        <Box component="form" onSubmit={handleSubmit} noValidate sx={{ mt: 1, width: '100%' }}>
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
            helperText="Nutze 'TESTuser' für den Schnellzugriff"
          />
          
          {isRegister && (
            <TextField
              margin="normal"
              required
              fullWidth
              select
              name="language"
              label="Sprache"
              defaultValue="de"
              id="language"
            >
              <MenuItem value="de">Deutsch</MenuItem>
              <MenuItem value="en">English</MenuItem>
            </TextField>
          )}

          <Button
            type="submit"
            fullWidth
            variant="contained"
            sx={{ mt: 3, mb: 2 }}
          >
            {isRegister ? 'Konto erstellen' : 'Anmelden'}
          </Button>
          
          <Button
            fullWidth
            variant="text"
            onClick={toggleMode}
          >
            {isRegister ? 'Bereits ein Konto? Anmelden' : 'Noch kein Konto? Registrieren'}
          </Button>
        </Box>
      </Paper>
    </Container>
  );
}
