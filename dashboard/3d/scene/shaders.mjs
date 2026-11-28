import { plowedSoil, rakingLight } from "../scenery/layers.mjs";
export const vs = `attribute vec3 p,color;attribute vec4 spot;uniform float plant;uniform vec2 origin;uniform vec4 cam;uniform vec2 screenSize;attribute vec2 tex;attribute float flex;varying mediump float floorLayer;varying vec2 uv,land,fogScreen;varying vec3 rgb;uniform vec2 view;uniform float lift;uniform highp float time;uniform highp vec4 lens;uniform mediump float shadow;void main(){vec3 v=p;float sway=max(flex,0.);if(plant>.5){float cs=cos(spot.w),sn=sin(spot.w);v=vec3(spot.x+(p.x*cs-p.z*sn)*spot.z,p.y*spot.z,spot.y+(p.x*sn+p.z*cs)*spot.z);sway*=spot.z;}v.xz+=origin;v.x+=sway*(sin(time*1.4+v.x*.034+v.z*.021)+.3*sin(time*2.+v.z*.08));if(shadow>.5){if(plant>.5||tex.x<= -3.||tex.x>1.5){v.x+=v.y*.53;v.z+=v.y*.7;}else{float ray=(1.-tex.y)*(-flex);v.x+=ray*.75;v.z+=ray*1.38-v.y*.35;}v.y=0.;}vec2 proj=vec2(v.x,(v.z-lift*v.y)*cam.w)*cam.z+cam.xy;float ground=(v.z*cam.w*cam.z+cam.y)/screenSize.y;
float depth=1.+lens.z*(.5-ground-.84*v.y*cam.z/screenSize.y);
float height=mix(lift*cam.w,1.18,lens.z/.44)*v.y*cam.z/screenSize.y;
float y=lens.w*depth+lens.y*ground-height;
gl_Position=vec4(lens.x*(2.*proj.x/screenSize.x-1.),depth-2.*y,(.86-v.y*.009-v.z/view.y*.32)*depth,depth);uv=tex;land=v.xz/view;rgb=color;
 if(plant>.5){float seedTone=.5+.5*sin(spot.w*2.8);rgb*=mix(vec3(.74,.77,.64),vec3(1.13,.99,.71),seedTone);rgb+=vec3(.07,.043,.005)*smoothstep(1.2,1.7,p.y);}
 fogScreen=vec2(0.);
 if(tex.x<=-8.){
   vec2 lo=vec2(1e4), hi=-lo;
   for(int i=0;i<8;i++){
     vec2 corner=origin+color.xy*vec2(mod(float(i),2.),mod(floor(float(i)/2.),2.));
     float altitude=floor(float(i)/4.)*color.z*cam.z/screenSize.y;
     float g=(corner.y*cam.w*cam.z+cam.y)/screenSize.y;
     float d=1.+lens.z*(.5-g-.84*altitude);
     vec2 projected=vec2(.5+lens.x*((corner.x*cam.z+cam.x)/screenSize.x-.5)/d,
       lens.w+(lens.y*g-mix(lift*cam.w,1.18,lens.z/.44)*altitude)/d);
     lo=min(lo,projected); hi=max(hi,projected);
   }
   fogScreen=mix(lo,hi,vec2(-tex.x-8.,tex.y));
   gl_Position=vec4(fogScreen*vec2(2.,-2.)+vec2(-1.,1.),.84-(origin.y+color.y)/view.y*.32-color.z*.009,1.);
 }
 floorLayer=0.;
 if(p.y<-.1 && plant<.5 && tex.x>=0. && tex.x<=1.){gl_Position=vec4(tex.x*2.-1.,1.-tex.y*2.,.99,1.);uv=tex;floorLayer=1.;}}`;
export const fs = `precision highp float;varying mediump float floorLayer;varying vec2 uv,land,fogScreen;varying vec3 rgb;uniform highp vec2 screenSize;uniform highp vec2 origin;uniform highp vec4 cam;uniform sampler2D photo,foliage,clods,borderGrass,crops;uniform mediump float cover;uniform mediump float plotShade;uniform highp float lift;uniform highp vec2 view;uniform highp float time;uniform highp vec4 lens;uniform vec3 mistTint;uniform vec2 grassCrop;uniform mediump float shadow;${rakingLight}
${plowedSoil}
float hash3(vec3 p){
      p=fract(p*vec3(.1031,.1030,.0973));
      p+=dot(p,p.yxz+33.33);
      return fract((p.x+p.y)*p.z);
    }
    float noise3(vec3 p){
      vec3 i=floor(p),f=fract(p);
      f=f*f*(3.-2.*f);
      vec4 a=vec4(hash3(i),hash3(i+vec3(0,1,0)),hash3(i+vec3(0,0,1)),hash3(i+vec3(0,1,1)));
      vec3 j=i+vec3(1,0,0);
      vec4 b=vec4(hash3(j),hash3(j+vec3(0,1,0)),hash3(j+vec3(0,0,1)),hash3(j+vec3(0,1,1)));
      vec4 c=mix(a,b,f.x);
      return mix(mix(c.x,c.y,f.y),mix(c.z,c.w,f.y),f.z);
    }
    float vapor(vec3 p){
      float large=noise3(p);
      return large*.63+noise3(p*2.17+vec3(large*1.9,.8,4.2))*.27+noise3(p*4.58+large)*.10;
    }
    vec2 worldAtHeight(float height){
      float row=fogScreen.y-lens.w;
      float altitude=height*cam.z/screenSize.y;
      float g=(row*(1.+lens.z*.5)+altitude*(mix(lift*cam.w,1.18,lens.z/.44)-row*lens.z*.84))/(lens.y+row*lens.z);
      float d=1.+lens.z*(.5-g-.84*altitude);
      vec2 pixels=vec2((fogScreen.x-.5)*d/lens.x+.5,g)*screenSize;
      return (pixels-cam.xy)/(cam.z*vec2(1.,cam.w))-origin;
    }
    vec4 marchFog(vec3 box){
      float width=box.x,depth=box.y,height=box.z;
      vec2 foot=worldAtHeight(0.);
      vec2 ray=(worldAtHeight(height)-foot)/height;
      vec2 safeRay=vec2(ray.x<0.?-1.:1.,ray.y<0.?-1.:1.)*max(abs(ray),vec2(.00001));
      vec2 a=-foot/safeRay,b=(box.xy-foot)/safeRay;
      vec2 enter=min(a,b),leave=max(a,b);
      float bottom=max(0.,max(enter.x,enter.y)),top=min(height,min(leave.x,leave.y));
      if(top<=bottom)return vec4(0.);
      const int steps=16;
      float dy=(top-bottom)/float(steps);
      float pathLength=dy*sqrt(1.+dot(ray,ray))/height;
      vec3 light=vec3(0.);
      float transmit=1.;
      vec3 wind=vec3(-time*.135,time*.032,-time*.042);
      vec3 sky=mix(mistTint,vec3(1.,.976,.91),.84);
      vec3 underside=mistTint*vec3(.61,.685,.73);

      for(int i=0;i<steps;i++){
        float y=top-(float(i)+.5)*dy;
        vec2 pos=foot+y*ray;
        float x=pos.x,z=pos.y;
        float sideX=smoothstep(0.,min(width*.39,23.),min(x,width-x));
        float altitude=y/height;
        vec3 sampleAt=vec3((x+origin.x)/clamp(width*.28,6.,27.),y/clamp(height*.7,6.,17.),
          (z+origin.y)/clamp(depth*.34,7.,19.))+wind;
        float billow=vapor(sampleAt);
        float sideZ=smoothstep(0.,min(depth*.33,18.),min(z,depth-z));
        float edge=sideX*sideZ;
        float envelope=pow(max(edge,.0001),.62)*(.79+.41*billow);
        float density=smoothstep(-.13,.25,billow*1.15+.23-altitude/max(.01,envelope));
        density*=edge*smoothstep(0.,.12,altitude)*(.44+.88*billow);
        float absorbed=1.-exp(-density*pathLength*5.8);
        float sun=noise3(sampleAt+vec3(-.44,.54,-.20));
        float lit=clamp(.18+altitude*.70+1.35*(billow-sun),0.,1.);
        light+=transmit*absorbed*mix(underside,sky,lit);
        transmit*=1.-absorbed;
        if(transmit<.008)break;
      }
      return vec4(light/max(.00001,1.-transmit),1.-transmit);
    }
    vec3 meadowAt(vec2 coords){
      vec2 world=coords*view;
      vec3 grass=texture2D(borderGrass,world/96.).rgb;
      vec4 marks=texture2D(photo,clamp(coords,0.,1.));
      float boundary=min(min(coords.x,1.-coords.x)*view.x,min(coords.y,1.-coords.y)*view.y);
      return mix(grass,marks.rgb,marks.a*smoothstep(0.,38.,boundary));
    }
    void main(){if(floorLayer>.5){
float t=(uv.y-lens.w)*(1.+lens.z*.5)/(lens.y+lens.z*(uv.y-lens.w));
float denom=1.+lens.z*(.5-t);
vec2 raw=vec2((uv.x-.5)*denom/lens.x+.5,t)*screenSize;
vec2 groundUV=(raw-cam.xy)/(cam.z*vec2(1.,cam.w)*view);vec2 meadow=groundUV*view;
    float beam=fieldLightNoise(vec2(meadow.x/230.,(meadow.y+.19*meadow.x)/58.));
    vec3 light=mix(vec3(.80,.82,.78),vec3(1.31,1.22,.92),smoothstep(.31,.74,beam));
    gl_FragColor=vec4(meadowAt(groundUV)*light*(.87+.23*texture2D(borderGrass,meadow/33.).g),1.);}else if(cover>.5){vec2 world=land*view;
      vec2 uvWorld=world/(cover>1.5?vec2(48.,39.):vec2(108.,105.));
      vec2 tile=1.-abs(mod(uvWorld,2.)-1.);
      vec3 c=cover>1.5 ? mix(vec3(.225,.249,.105),texture2D(crops,tile).rgb,.35)*rakingLight(world) : plowedSoil(world,fract((world.x+.32*world.y)/14.),clods);
      gl_FragColor=vec4(c*(1.+plotShade*vec3(.24,.12,-.13)),1.);
    }else if(uv.x < -7.0){
      gl_FragColor=marchFog(rgb);
    }else if(uv.x<=-3.5){
      vec2 world=land*view;
      float fleck=fieldLightNoise(world*1.4+uv.y*.63);
      float patina=fieldLightNoise(world*.19+uv.y*.17);
      vec3 base=rgb*mix(.78,1.18,fleck);
      if(uv.x> -4.5) base=mix(base,vec3(.29,.31,.15),smoothstep(.48,.82,patina)*.62);
      else base*=.88+.14*patina+.03*sin(uv.y*3.14);
      gl_FragColor=vec4(shadow>.5?vec3(.18,.19,.11):base*rakingLight(world),1.);
    }else if(uv.x>3.5){gl_FragColor=vec4(plowedSoil(land*view,uv.x-5.,clods)*(1.+plotShade*vec3(.24,.12,-.13)),1.);}else if(uv.x>1.5){vec4 leaf=texture2D(foliage,uv-vec2(2.,0.));if(leaf.a<.48)discard;gl_FragColor=vec4(shadow>.5?meadowAt(land)*vec3(.69,.68,.58):leaf.rgb*rgb,1.);}else gl_FragColor=vec4(shadow>.5?meadowAt(land)*vec3(.73,.73,.62):(uv.x<0.?rgb*rakingLight(land*view)*(1.+plotShade*vec3(.24,.12,-.13)) :texture2D(photo,uv).rgb*rgb),1.);}`;
