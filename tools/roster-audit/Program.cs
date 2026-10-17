using System;
using System.Collections.Generic;
using OpenRA;

try
{
  var options = new Dictionary<string, string>();
  for (var i = 0; i < args.Length; i += 2) options.Add(args[i].TrimStart('-'), args[i + 1]);
  return FactionRosterAudit.Run(options);
}
finally { Log.Dispose(); }
