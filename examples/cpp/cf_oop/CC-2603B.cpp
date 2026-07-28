#include<iostream>
#include<vector>
#include<algorithm>
#include<cstdlib>
using namespace std;
class Fraction{public:
   int x,y;
   Fraction(int a=0,int b=0):x(a),y(b){}
         Fraction operator +( Fraction b){
                return  Fraction(x*b.y+y*b.x,y*b.y);
        }
         Fraction operator *( Fraction b){
                return  Fraction(x*b.x,y*b.y);
        }
         Fraction operator /(int b){
                return  Fraction(x,y*b);
        }
};
istream& operator>>(istream &is,Fraction &a){char c;return is>>a.x>>c>>a.y;}
ostream& operator<<(ostream &os,const Fraction &a){return os<<a.x<<"/"<<a.y;}

class FVec{
     vector<Fraction>fv;
public:

     void push(Fraction f){fv.push_back(f);}
     Fraction reduce(Fraction f)const{
         int g=std::__gcd(f.x<0?-f.x:f.x, f.y<0?-f.y:f.y);
         if(g==0) g=1;
         return Fraction(f.x/g, f.y/g);
     }
     Fraction sum(){
         Fraction s=fv[0];
         for(size_t i=1;i<fv.size();i++) s=s+fv[i];
         return reduce(s);
     }
     Fraction pro(){
         Fraction p=fv[0];
         for(size_t i=1;i<fv.size();i++) p=p*fv[i];
         return reduce(p);
     }
     Fraction avg(){
         return reduce(sum()/(int)fv.size());
     }

};
istream& operator>>(istream &xis,FVec &a){
     int n;xis>>n;
     for(int i=0;i<n;i++){Fraction f;xis>>f;a.push(f);}
     return xis;
}
int main(){
  FVec a;cin>>a;
  cout<<a.sum()<<endl<<a.pro()<<endl<<a.avg()<<endl;  //@ @guide uml:a
  return 0;
}
